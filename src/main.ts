#!/usr/bin/env node
import { readFileSync, readSync } from 'node:fs';
import { MAX_REQUEST_BYTES, parseRunRequest } from './gateway/request.js';
import { realPlanEnv } from './launch/rootfs-plan.js';
import {
  ensureParent,
  locateDelegation,
  pidIsAlive,
  realCgroupFs,
  reapOrphanCells,
} from './launch/cgroup.js';
import { runCell } from './launch/run-cell.js';
import { commitChanges, resolveCommitRoot, type CommitOutcome } from './collect/commit.js';
import { discardWorkspace } from './collect/discard.js';
import { loadPolicy, type Policy } from './policy/policy.js';
import { collectIsolationReport } from './probe/isolation-probe.js';
import { reapStaleTempDirs } from './util/tempdir.js';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectProbe, realProbeEnv } from './probe/probe.js';
import { checkExecutable, locateHelper, moduleDir } from './sys/helper.js';
import { errFromException, errnoCode, ok, type Result } from './util/result.js';

// sysexits.h values, spelled out so each exit status is documented where it is used.
const EX_USAGE = 64;
const EX_DATAERR = 65;
const EX_SOFTWARE = 70;

const NOT_IMPLEMENTED = new Set(['serve', 'mcp']);

function repoPolicyPath(): string {
  return join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'policy.default.json');
}

function loadPolicyOrDefault(): Policy {
  const r = loadPolicy(process.env['AEGIS_POLICY_FILE'] ?? repoPolicyPath());
  return r.ok ? r.value : { ingestRoots: [], ingestExcludes: [], commitRoots: [] };
}

function logFatal(event: string, reason: unknown): void {
  // Only the event name and an error code are logged: never the message, which could carry
  // payload or path data (CLAUDE.md 5.3).
  process.stderr.write(`${JSON.stringify({ level: 'fatal', event, code: errnoCode(reason) })}\n`);
}

process.on('unhandledRejection', (reason: unknown) => {
  logFatal('unhandled_rejection', reason);
  process.exit(EX_SOFTWARE);
});
process.on('uncaughtException', (error: unknown) => {
  logFatal('uncaught_exception', error);
  process.exit(EX_SOFTWARE);
});

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * Reads the request from a file or stdin. At most MAX_REQUEST_BYTES + 1 bytes are kept, so an
 * oversize request is detected by the schema layer without ever being held in full.
 */
function readRequest(path: string | null): Result<Buffer> {
  const limit = MAX_REQUEST_BYTES + 1;
  try {
    if (path !== null) {
      return ok(readFileSync(path).subarray(0, limit));
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.alloc(64 * 1024);
    while (total < limit) {
      let n: number;
      try {
        n = readSync(0, chunk, 0, Math.min(chunk.length, limit - total), null);
      } catch (e) {
        if (errnoCode(e) === 'EAGAIN') continue;
        if (errnoCode(e) === 'EOF') break;
        throw e;
      }
      if (n === 0) break;
      chunks.push(Buffer.from(chunk.subarray(0, n)));
      total += n;
    }
    return ok(Buffer.concat(chunks, total));
  } catch (e) {
    return errFromException(e, 'read request');
  }
}

/** Removes cells left behind by engine processes that no longer exist (CLAUDE.md 6.1 item 7). */
async function reapOrphans(): Promise<void> {
  const fs = realCgroupFs();
  try {
    const text = readFileSync('/proc/self/cgroup', 'utf8');
    const del = locateDelegation(fs, process.getuid?.() ?? -1, text);
    if (del.ok) {
      const parent = ensureParent(fs, del.value.root);
      if (parent.ok) {
        await reapOrphanCells(fs, parent.value.path);
      }
    }
  } catch {
    // Reaping is best effort: a failure here must not stop a run, and the next run retries.
  }
  reapStaleTempDirs(tmpdir(), pidIsAlive);
}

async function runMode(args: readonly string[]): Promise<number> {
  let file: string | null = null;
  if (args.length === 2 && args[0] === '--file' && args[1] !== undefined) {
    file = args[1];
  } else if (args.length !== 0) {
    process.stderr.write('usage: aegis run [--file <request.json>]\n');
    return EX_USAGE;
  }

  const bytes = readRequest(file);
  if (!bytes.ok) {
    printJson({ error: { code: 'unreadable_request', detail: bytes.error.code } });
    return EX_DATAERR;
  }
  const req = parseRunRequest(bytes.value);
  if (!req.ok) {
    printJson({ error: { code: 'invalid_request', detail: req.error.context } });
    return EX_DATAERR;
  }

  const helper = locateHelper(process.env, moduleDir());
  if (!helper.ok) {
    printJson({
      id: req.value.id,
      error: { code: 'helper_unavailable', detail: helper.error.code },
    });
    return EX_SOFTWARE;
  }
  const exec = checkExecutable(helper.value.path);
  if (!exec.ok) {
    printJson({ id: req.value.id, error: { code: 'helper_unavailable', detail: exec.error.code } });
    return EX_SOFTWARE;
  }

  await reapOrphans();
  const result = await runCell(req.value, {
    helperPath: helper.value.path,
    planEnv: realPlanEnv(),
    ingestPolicy: loadPolicyOrDefault(),
  });
  if (!result.ok) {
    printJson({
      id: req.value.id,
      error: { code: 'internal_error', detail: `${result.error.code}: ${result.error.context}` },
    });
    return EX_SOFTWARE;
  }
  printJson(result.value);
  return 0;
}

function workspaceDirFor(id: string): string {
  return join(tmpdir(), `aegis-workspace-${id}`);
}

interface PersistedChanges {
  readonly mode: 'overlay' | 'copy';
  readonly upper: string;
  readonly lower: string;
  readonly changes: readonly {
    readonly path: string;
    readonly op: 'add' | 'modify' | 'delete';
  }[];
}

function readPersistedChanges(id: string): Result<PersistedChanges> {
  try {
    const text = readFileSync(join(workspaceDirFor(id), 'changes.json'), 'utf8');
    const data: unknown = JSON.parse(text);
    if (typeof data !== 'object' || data === null || !('changes' in data)) {
      return errFromException(new Error('malformed changes.json'), 'read changes.json');
    }
    const changes = data.changes;
    if (!Array.isArray(changes)) {
      return errFromException(new Error('malformed changes.json'), 'read changes.json');
    }
    return ok(data as PersistedChanges);
  } catch (e) {
    return errFromException(e, `read changes for ${id}`);
  }
}

async function commitMode(args: readonly string[]): Promise<number> {
  const id = args[0];
  if (id === undefined) {
    process.stderr.write('usage: aegis commit <run-id> [--dest <path>] [--paths p1,p2,...]\n');
    return EX_USAGE;
  }
  let dest: string | undefined;
  let paths: string[] | null = null;
  for (let i = 1; i < args.length; i += 2) {
    if (args[i] === '--dest') dest = args[i + 1];
    else if (args[i] === '--paths') paths = (args[i + 1] ?? '').split(',').filter((p) => p !== '');
  }
  if (dest === undefined) {
    process.stderr.write('aegis commit: --dest is required\n');
    return EX_USAGE;
  }
  const persisted = readPersistedChanges(id);
  if (!persisted.ok) {
    printJson({ id, error: { code: 'no_such_run', detail: persisted.error.context } });
    return EX_DATAERR;
  }
  const policy = loadPolicyOrDefault();
  const root = await resolveCommitRoot(dest, policy);
  if (!root.ok) {
    printJson({ id, error: { code: 'commit_root_refused', detail: root.error.code } });
    return EX_DATAERR;
  }
  const helper = locateHelper(process.env, moduleDir());
  if (!helper.ok) {
    printJson({ id, error: { code: 'helper_unavailable', detail: helper.error.code } });
    return EX_SOFTWARE;
  }
  const outcomes: CommitOutcome[] = await commitChanges(
    root.value,
    persisted.value.upper,
    persisted.value.changes.map((c) => ({ ...c, bytes: null, sha256: null })),
    paths,
    { fsopPath: helper.value.path },
  );
  printJson({ id, outcomes });
  return 0;
}

function discardMode(args: readonly string[]): number {
  const id = args[0];
  if (id === undefined) {
    process.stderr.write('usage: aegis discard <run-id>\n');
    return EX_USAGE;
  }
  const r = discardWorkspace({ dir: workspaceDirFor(id) });
  if (!r.ok) {
    printJson({ id, error: { code: 'discard_failed', detail: r.error.context } });
    return EX_SOFTWARE;
  }
  printJson({ id, discarded: true });
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const mode = argv[0];

  if (mode === 'probe') {
    const report = await collectProbe(realProbeEnv());
    const helper = locateHelper(process.env, moduleDir());
    const helperPath =
      helper.ok && checkExecutable(helper.value.path).ok ? helper.value.path : null;
    await reapOrphans();
    const isolation = await collectIsolationReport(helperPath);
    process.stdout.write(`${JSON.stringify({ ...report, isolation }, null, 2)}\n`);
    return 0;
  }

  if (mode === 'run') {
    return runMode(argv.slice(1));
  }

  if (mode === 'commit') {
    return commitMode(argv.slice(1));
  }

  if (mode === 'discard') {
    return discardMode(argv.slice(1));
  }

  if (mode !== undefined && NOT_IMPLEMENTED.has(mode)) {
    process.stderr.write(`aegis ${mode}: not implemented yet\n`);
    return EX_USAGE;
  }

  process.stderr.write(
    'usage: aegis probe | run [--file <request.json>] | commit <id> --dest <path> | discard <id>\n',
  );
  return EX_USAGE;
}

process.exitCode = await main(process.argv.slice(2));
