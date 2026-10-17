import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { diffCopyResult, diffOverlayUpper, type Change } from '../collect/diff.js';
import { commitChanges, resolveCommitRoot, type CommitOutcome } from '../collect/commit.js';
import type { RunRequest } from '../gateway/request.js';
import { ensureParent, locateDelegation, realCgroupFs, type CgroupFs } from '../launch/cgroup.js';
import type { PlanEnv } from '../launch/rootfs-plan.js';
import { runCell, type CellResult, type RunCellDeps } from '../launch/run-cell.js';
import { canonicalJson } from '../policy/canonical.js';
import { resolveManifest } from '../policy/manifest.js';
import type { Policy } from '../policy/policy.js';
import { nullLogger, type Logger } from '../util/logger.js';
import { err, ok, type Result } from '../util/result.js';
import { Admission, DEFAULT_WAIT_MS } from './admission.js';
import { RunEvents } from './events.js';
import { SessionStore } from './session-store.js';

// The engine (prompt Stage 5 section 4): one in-process service that both front ends (the HTTP
// gateway and the MCP server) and the one-shot CLI are thin adapters over. It owns the session
// table, admission control and the event streams, and calls `runCell` for each run.

export type EngineReceipt = CellResult & { readonly run: string; readonly session: string | null };

export interface EngineDeps {
  readonly helperPath: string;
  readonly planEnv: PlanEnv;
  readonly policy: Policy;
  /** Parent of the `aegis-workspace-<id>` directories; the OS temp directory by default. */
  readonly workspaceParent?: string;
  readonly logger?: Logger;
  /** Passed through to `runCell` (test seams and the test-only ablation list). */
  readonly runCellExtras?: Partial<RunCellDeps>;
  readonly now?: () => number;
  readonly pid?: number;
}

export interface RunInput {
  readonly request: RunRequest;
  /** Continue this session. Omit to create one (when the request has files or a source). */
  readonly session?: string | null;
  /** `server`: generate unguessable ids (gateway, MCP). `request`: use the request id (CLI). */
  readonly idMode: 'server' | 'request';
  /** Wait at most this long for capacity before refusing with `busy`. */
  readonly admissionWaitMs?: number;
}

export interface RunHandle {
  readonly id: string;
  readonly session: string | null;
  readonly events: RunEvents;
  readonly result: Promise<Result<EngineReceipt>>;
  cancel(): void;
}

export interface DiffReport {
  readonly session: string;
  readonly mode: 'overlay' | 'copy';
  readonly source: string | null;
  readonly changes: readonly Change[];
  readonly changes_sha256: string;
  readonly patch_truncated: boolean;
}

export type CommitResult =
  | { readonly kind: 'stale'; readonly diff: DiffReport }
  | {
      readonly kind: 'done';
      readonly outcomes: readonly CommitOutcome[];
      readonly changes_sha256: string;
    };

interface RunRecord {
  readonly id: string;
  readonly session: string | null;
  readonly events: RunEvents;
  readonly controller: AbortController;
  state: 'queued' | 'running' | 'done' | 'failed';
  result: Result<EngineReceipt> | null;
  finishedMs: number | null;
}

const FINISHED_KEEP_MS = 5 * 60_000;
const FINISHED_KEEP_MAX = 64;
const MAX_PATCH_BYTES = 256 * 1024;
const SWEEP_MS = 60_000;

export function newSessionId(): string {
  return `s-${randomBytes(16).toString('hex')}`;
}
export function newRunId(): string {
  return `r-${randomBytes(16).toString('hex')}`;
}

/** SHA-256 of the canonical change list: what an approver saw is what `commit` applies. */
export function changesSha256(changes: readonly Change[], hash: (s: string) => string): string {
  const rows = [...changes]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((c) => [
      c.path,
      c.op,
      c.bytes,
      c.sha256,
      c.diff?.startsWith('symlink -> ') === true ? c.diff : null,
    ]);
  const text = canonicalJson(rows);
  if (!text.ok) throw new TypeError('change list is not canonicalisable');
  return hash(text.value);
}

export class Engine {
  readonly #deps: EngineDeps;
  readonly #log: Logger;
  readonly #store: SessionStore;
  readonly #admission: Admission;
  readonly #runs = new Map<string, RunRecord>();
  readonly #now: () => number;
  #timer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(deps: EngineDeps) {
    this.#deps = deps;
    this.#log = deps.logger ?? nullLogger;
    this.#now = deps.now ?? (() => Date.now());
    const c = deps.policy.ceiling;
    this.#store = new SessionStore({
      parent: deps.workspaceParent ?? tmpdir(),
      maxSessions: c.maxSessions,
      idleMs: c.sessionIdleS * 1000,
      now: this.#now,
      ...(deps.pid === undefined ? {} : { pid: deps.pid }),
    });
    this.#admission = new Admission(c.maxCells, c.memoryBudgetMb);
  }

  get sessions(): SessionStore {
    return this.#store;
  }

  /** Starts the periodic sweep of idle sessions and old run records, and sweeps leftovers once. */
  start(): void {
    this.#store.sweepOrphans().forEach((s) => {
      this.#log.log({ event: 'session_swept', session: s });
    });
    this.#timer = setInterval(() => {
      this.sweep();
    }, SWEEP_MS);
    this.#timer.unref();
    this.#log.log({ event: 'engine_started' });
  }

  sweep(): void {
    for (const s of this.#store.expireIdle())
      this.#log.log({ event: 'session_expired', session: s });
    this.#pruneRuns();
  }

  #pruneRuns(): void {
    const now = this.#now();
    const finished = [...this.#runs.values()]
      .filter((r) => r.finishedMs !== null)
      .sort((a, b) => (a.finishedMs ?? 0) - (b.finishedMs ?? 0));
    for (const r of finished) {
      if (now - (r.finishedMs ?? now) > FINISHED_KEEP_MS) this.#runs.delete(r.id);
    }
    const left = finished.filter((r) => this.#runs.has(r.id));
    for (const r of left.slice(0, Math.max(0, left.length - FINISHED_KEEP_MAX))) {
      this.#runs.delete(r.id);
    }
  }

  /** Cancels every running run, waits for them (bounded), and stops the sweep. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    const pending: Promise<unknown>[] = [];
    for (const r of this.#runs.values()) {
      if (r.state === 'queued' || r.state === 'running') {
        r.controller.abort();
        pending.push(
          new Promise<void>((resolve) => {
            const check = (): void => {
              if (r.finishedMs !== null) resolve();
              else setTimeout(check, 20);
            };
            check();
          }),
        );
      }
    }
    await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 8000))]);
    this.#log.log({ event: 'engine_stopped' });
  }

  startRun(input: RunInput): Result<RunHandle> {
    if (this.#closed) return err('ESHUTDOWN', 'the engine is shutting down');
    const req = input.request;
    this.#pruneRuns();

    // Which session does this run belong to?
    let sessionId: string | null = null;
    let continuing = false;
    if (input.session !== undefined && input.session !== null) {
      if (req.workspaceSource !== null) {
        return err('EINVAL', 'a workspace source can only be given when a session is created');
      }
      const begun = this.#store.begin(input.session);
      if (!begun.ok) return begun;
      sessionId = input.session;
      continuing = true;
    } else if (req.workspaceSource !== null || req.files.length > 0) {
      const id = input.idMode === 'request' ? req.id : newSessionId();
      const created = this.#store.create(id, req.workspaceSource);
      if (!created.ok) return created;
      sessionId = id;
      this.#log.log({ event: 'session_created', session: id });
    }

    const runId = input.idMode === 'request' ? req.id : newRunId();
    const controller = new AbortController();
    const events = new RunEvents();
    const record: RunRecord = {
      id: runId,
      session: sessionId,
      events,
      controller,
      state: 'queued',
      result: null,
      finishedMs: null,
    };
    this.#runs.set(runId, record);
    const session = sessionId === null ? undefined : this.#store.get(sessionId);

    const result = this.#execute(record, input, session?.dir ?? null, continuing);
    return ok({
      id: runId,
      session: sessionId,
      events,
      result,
      cancel: () => {
        controller.abort();
      },
    });
  }

  async #execute(
    record: RunRecord,
    input: RunInput,
    sessionDir: string | null,
    continuing: boolean,
  ): Promise<Result<EngineReceipt>> {
    const req = input.request;
    const { manifest, sha256 } = resolveManifest(req.manifest, this.#deps.policy.ceiling);
    this.#log.log({
      event: 'run_queued',
      run: record.id,
      session: record.session,
      manifest_sha256: sha256,
    });

    const finish = (
      r: Result<EngineReceipt>,
      failure?: { code: string },
    ): Result<EngineReceipt> => {
      record.result = r;
      record.state = r.ok ? 'done' : 'failed';
      record.finishedMs = this.#now();
      if (r.ok) {
        record.events.push({ type: 'receipt', receipt: r.value });
      } else {
        record.events.push({ type: 'failed', code: failure?.code ?? r.error.code });
      }
      record.events.finish();
      return r;
    };

    const admitted = await this.#admission.acquire(manifest.limits.memory_mb, {
      signal: record.controller.signal,
      waitMs: input.admissionWaitMs ?? DEFAULT_WAIT_MS,
      onPosition: (position) => {
        record.events.push({ type: 'queued', position });
      },
    });
    if (!admitted.ok) {
      this.#endSession(record.session, null, continuing, true);
      this.#log.log({
        event: admitted.error.code === 'ECANCELED' ? 'run_cancelled' : 'run_refused',
        run: record.id,
        session: record.session,
        manifest_sha256: sha256,
        code: admitted.error.code,
      });
      return finish(admitted);
    }

    record.state = 'running';
    let ran: Result<CellResult>;
    try {
      ran = await runCell(req, {
        helperPath: this.#deps.helperPath,
        planEnv: this.#deps.planEnv,
        governance: {
          ceiling: this.#deps.policy.ceiling,
          ceilingSha256: this.#deps.policy.ceilingSha256,
        },
        ingestPolicy: this.#deps.policy,
        ...(this.#deps.workspaceParent === undefined
          ? {}
          : { workspaceParent: this.#deps.workspaceParent }),
        ...(sessionDir === null ? {} : { workspace: { dir: sessionDir, existing: continuing } }),
        ...this.#deps.runCellExtras,
        onEvent: (e) => {
          record.events.push(e);
        },
        signal: record.controller.signal,
      });
    } finally {
      admitted.value();
    }

    if (!ran.ok) {
      this.#endSession(record.session, null, continuing, true);
      this.#log.log({
        event: 'run_failed',
        run: record.id,
        session: record.session,
        manifest_sha256: sha256,
        code: ran.error.code,
      });
      return finish(ran);
    }

    const cell = ran.value;
    // A first run that never got as far as running (isolation refused, ingest refused) leaves no
    // useful session behind.
    const refusedFirst = !continuing && cell.termination.cause === 'isolation_unavailable';
    this.#endSession(record.session, cell.workspace ?? null, continuing, refusedFirst);
    const cause = cell.termination.cause;
    this.#log.log({
      event:
        cause === 'cancelled'
          ? 'run_cancelled'
          : cause === 'isolation_unavailable'
            ? 'run_refused'
            : 'run_finished',
      run: record.id,
      session: record.session,
      manifest_sha256: cell.manifest_sha256,
      cause,
      level: cell.isolation.level,
      wall_ms: cell.usage.wall_ms,
    });
    return finish(ok({ ...cell, run: record.id, session: record.session }));
  }

  #endSession(
    id: string | null,
    mode: 'overlay' | 'copy' | null,
    continuing: boolean,
    discardIfNew: boolean,
  ): void {
    if (id === null) return;
    if (!continuing && discardIfNew) {
      this.#store.discard(id);
      return;
    }
    this.#store.end(id, mode);
  }

  getRun(id: string): RunRecord | undefined {
    return this.#runs.get(id);
  }

  cancelRun(id: string): Result<void> {
    const r = this.#runs.get(id);
    if (r === undefined) return err('ENOENT', 'no such run');
    if (r.state === 'done' || r.state === 'failed') return err('ESRCH', 'the run already finished');
    r.controller.abort();
    return ok(undefined);
  }

  // ---- sessions: diff, commit, discard -------------------------------------------------------

  #sessionFor(id: string, adopt: boolean): Result<NonNullable<ReturnType<SessionStore['get']>>> {
    const s = this.#store.get(id);
    if (s !== undefined) return ok(s);
    return adopt ? this.#store.adopt(id) : err('ENOENT', 'no such session');
  }

  diff(id: string, opts: { adopt?: boolean } = {}): Result<DiffReport> {
    const s = this.#sessionFor(id, opts.adopt === true);
    if (!s.ok) return s;
    if (s.value.state === 'running') return err('EBUSY', 'the session is running a cell');
    if (s.value.mode === null) return err('ENOENT', 'the session has no workspace to diff yet');
    const raw =
      s.value.mode === 'overlay'
        ? diffOverlayUpper(s.value.lower, s.value.upper)
        : diffCopyResult(s.value.lower, s.value.upper);
    if (!raw.ok) return raw;
    let budget = MAX_PATCH_BYTES;
    let truncated = false;
    const changes = raw.value.map((c) => {
      if (c.diff === undefined) return c;
      if (c.diff.startsWith('symlink -> ')) return c;
      if (c.diff.length > budget) {
        truncated = true;
        return { path: c.path, op: c.op, bytes: c.bytes, sha256: c.sha256 };
      }
      budget -= c.diff.length;
      return c;
    });
    return ok({
      session: id,
      mode: s.value.mode,
      source: s.value.source,
      changes,
      changes_sha256: changesSha256(raw.value, (t) => sha256Hex(t)),
      patch_truncated: truncated,
    });
  }

  async commit(
    id: string,
    args: {
      /** Null applies every change (the human CLI); the gateway and MCP always pass a list. */
      readonly paths: readonly string[] | null;
      readonly expectedChangesSha256: string | null;
      readonly dest?: string;
      readonly close?: boolean;
      readonly adopt?: boolean;
    },
  ): Promise<Result<CommitResult>> {
    const d = this.diff(id, { adopt: args.adopt === true });
    if (!d.ok) return d;
    if (
      args.expectedChangesSha256 !== null &&
      args.expectedChangesSha256 !== d.value.changes_sha256
    ) {
      return ok({ kind: 'stale', diff: d.value });
    }
    const s = this.#store.get(id);
    if (s === undefined) return err('ENOENT', 'no such session');

    // The destination is the session's own source; only a session made from inline files alone
    // takes one from the caller, and either way it must be inside a commit root of the policy.
    let requested: string;
    if (s.source !== null) {
      if (args.dest !== undefined && args.dest !== s.source) {
        return err('EINVAL', 'this session has a source; the destination cannot be changed');
      }
      requested = s.source;
    } else if (args.dest !== undefined) {
      requested = args.dest;
    } else {
      return err('EINVAL', 'this session has no source; a destination is required');
    }
    const root = await resolveCommitRoot(requested, this.#deps.policy);
    if (!root.ok) return root;

    const changes = d.value.changes;
    const known = new Set(changes.map((c) => c.path));
    const outcomes: CommitOutcome[] = [];
    for (const p of args.paths ?? []) {
      if (!known.has(p)) {
        outcomes.push({ path: p, status: 'refused', reason: 'not in the current change list' });
      }
    }
    // The change list handed to commitChanges is the full one; paths filter it.
    const applied = await commitChanges(root.value, s.upper, changes, args.paths, {
      fsopPath: this.#deps.helperPath,
    });
    outcomes.push(...applied);
    this.#log.log({
      event: 'session_committed',
      session: id,
      paths: args.paths?.length ?? changes.length,
      committed: outcomes.filter((o) => o.status === 'committed').length,
      refused: outcomes.filter((o) => o.status === 'refused').length,
    });
    if (args.close === true) {
      this.#store.discard(id);
    } else {
      this.#store.end(id, s.mode);
    }
    return ok({ kind: 'done', outcomes, changes_sha256: d.value.changes_sha256 });
  }

  discard(id: string, opts: { adopt?: boolean } = {}): Result<void> {
    const s = this.#sessionFor(id, opts.adopt === true);
    if (!s.ok) return s;
    if (s.value.state === 'running') return err('EBUSY', 'the session is running a cell');
    const r = this.#store.discard(id);
    if (r.ok) this.#log.log({ event: 'session_discarded', session: id });
    return r;
  }

  // ---- status --------------------------------------------------------------------------------

  status(): {
    readonly version: string;
    readonly delegated: boolean;
    readonly cells: ReturnType<Admission['stats']>;
    readonly limits: { readonly max_cells: number; readonly memory_budget_mb: number };
    readonly sessions: readonly {
      readonly id: string;
      readonly state: string;
      readonly runs: number;
      readonly idle_s: number;
      readonly has_source: boolean;
    }[];
    readonly runs: { readonly active: number; readonly retained: number };
  } {
    const now = this.#now();
    const c = this.#deps.policy.ceiling;
    return {
      version: '0.0.0',
      delegated: this.#delegated(),
      cells: this.#admission.stats(),
      limits: { max_cells: c.maxCells, memory_budget_mb: c.memoryBudgetMb },
      sessions: this.#store.list().map((s) => ({
        id: s.id,
        state: s.state,
        runs: s.runs,
        idle_s: Math.round((now - s.lastUsedMs) / 1000),
        has_source: s.source !== null,
      })),
      runs: {
        active: [...this.#runs.values()].filter((r) => r.finishedMs === null).length,
        retained: this.#runs.size,
      },
    };
  }

  #delegated(): boolean {
    try {
      const fs: CgroupFs = realCgroupFs();
      const del = locateDelegation(
        fs,
        process.getuid?.() ?? -1,
        readFileSync('/proc/self/cgroup', 'utf8'),
      );
      if (!del.ok) return false;
      return ensureParent(fs, del.value.root).ok;
    } catch {
      return false;
    }
  }
}

function sha256Hex(t: string): string {
  return createHash('sha256').update(t, 'utf8').digest('hex');
}
