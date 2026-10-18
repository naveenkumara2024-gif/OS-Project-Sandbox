import { z } from 'zod';
import type { Engine, EngineReceipt } from '../../engine/engine.js';
import { codeFor, commitBodySchema, MESSAGES, sessionIdSchema } from '../errors.js';
import { parseRunRequest, requestSchema } from '../request.js';

// The MCP tools (prompt Stage 5 section 4.5). A tool of the server named `aegis` reaches Claude
// Code as `mcp__aegis__<name>`. A run that exits non-zero, times out, runs out of memory or is
// refused for isolation is NOT an error: its receipt is the data. `isError` is for problems with
// the call itself (bad arguments, unknown or busy session, stale diff, policy).

export interface ToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

export interface ToolContext {
  /** Registers something to call if the client cancels this call; called at once if it already did. */
  onCancel(fn: () => void): void;
}

export interface ToolDef {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
  call(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/** Output kept in an MCP result, per stream. The cell's own cap (output_kb) still applies. */
export const MCP_STREAM_BYTES = 64 * 1024;
/** Above this, the per-file patches are left out of a run result (use `diff` for them). */
const MAX_RESULT_BYTES = 200 * 1024;

function text(value: unknown): ToolResult {
  const body = JSON.stringify(value);
  return {
    content: [{ type: 'text', text: body }],
    structuredContent: JSON.parse(body) as Record<string, unknown>,
  };
}

function fail(code: string, extra: Record<string, unknown> = {}): ToolResult {
  const c = codeFor(code);
  const body = JSON.stringify({ error: { code: c, detail: MESSAGES[c] }, ...extra });
  return {
    content: [{ type: 'text', text: body }],
    structuredContent: JSON.parse(body) as Record<string, unknown>,
    isError: true,
  };
}

function failWith(
  code: ReturnType<typeof codeFor>,
  detail: string,
  extra: Record<string, unknown> = {},
): ToolResult {
  const body = JSON.stringify({ error: { code, detail }, ...extra });
  return {
    content: [{ type: 'text', text: body }],
    structuredContent: JSON.parse(body) as Record<string, unknown>,
    isError: true,
  };
}

function clip(s: string): { value: string; truncated: boolean } {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= MCP_STREAM_BYTES) return { value: s, truncated: false };
  return { value: b.subarray(0, MCP_STREAM_BYTES).toString('utf8'), truncated: true };
}

/** The receipt as an MCP result: output clipped, and patches dropped if the whole is too big. */
export function receiptForMcp(r: EngineReceipt): Record<string, unknown> {
  const out = clip(r.stdout);
  const err = clip(r.stderr);
  const base: Record<string, unknown> = {
    ...r,
    stdout: out.value,
    stderr: err.value,
    ...(out.truncated || err.truncated
      ? {
          output_truncated: {
            stdout: out.truncated,
            stderr: err.truncated,
            limit_bytes: MCP_STREAM_BYTES,
          },
        }
      : {}),
  };
  if (JSON.stringify(base).length > MAX_RESULT_BYTES && r.changes !== undefined) {
    base['changes'] = r.changes.map((c) => ({
      path: c.path,
      op: c.op,
      bytes: c.bytes,
      sha256: c.sha256,
    }));
    base['patches_omitted'] = 'the receipt was large; use the diff tool for the patches';
  }
  return base;
}

const schemaOpts = { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' } as const;
const inputSchemaOf = (s: z.ZodType): Record<string, unknown> => {
  const js = z.toJSONSchema(s, schemaOpts) as Record<string, unknown>;
  // MCP assumes 2020-12 when no dialect is named, so the keyword is left out.
  delete js['$schema'];
  return js;
};

const sessionArgs = z.strictObject({ session: sessionIdSchema });
const commitArgs = commitBodySchema.extend({ session: sessionIdSchema }).strict();

function argProblem(e: z.ZodError): ToolResult {
  const where = e.issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join('.') || '(arguments)'}: ${i.code}`)
    .join('; ');
  return failWith('invalid_request', `invalid arguments at ${where}`);
}

export function buildTools(engine: Engine): ToolDef[] {
  const run: ToolDef = {
    name: 'run',
    title: 'Run a command in an isolated cell',
    description:
      'Run a command in a fresh, isolated cell: a private root filesystem, no network, no capabilities, ' +
      'a syscall filter, a filesystem sandbox, and memory/CPU/process limits. The program cannot change your ' +
      'real project: files you pass in `files` and/or the directory named in `workspace.source` are copied ' +
      'into the cell, and what the program changes is returned as `changes`. `command[0]` must be an ' +
      'absolute path (for example /usr/bin/python3) and files are in the current directory. The result is a ' +
      'receipt: stdout, stderr, exit_code, termination.cause (exit, timeout, oom, cancelled, ...), usage, ' +
      'which isolation layers were active, the resolved manifest and any limits that were clamped. A ' +
      'non-zero exit is a normal result, not an error. To keep working on the same files, pass the ' +
      '`session` id from the result to later calls (only one run at a time per session); you may add or ' +
      'replace files with `files`. Use `diff` to review and `commit` to apply changes to the real project.',
    inputSchema: inputSchemaOf(requestSchema),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async call(args, ctx) {
      const parsed = parseRunRequest(JSON.stringify(args ?? {}));
      if (!parsed.ok) return failWith('invalid_request', parsed.error.context);
      const started = engine.startRun({ request: parsed.value, idMode: 'server' });
      if (!started.ok) return fail(started.error.code);
      ctx.onCancel(() => {
        started.value.cancel();
      });
      const r = await started.value.result;
      if (!r.ok) return fail(r.error.code);
      return text(receiptForMcp(r.value));
    },
  };

  const status: ToolDef = {
    name: 'status',
    title: 'Engine status and limits',
    description:
      'Report the engine: whether it can place cells, running and queued cells, open sessions, and the ' +
      'ceiling a run may ask for (maximum limits, the hosts a brokered network may list, and the layers ' +
      'every run must have). Read-only.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    call(args) {
      if (
        args !== undefined &&
        (typeof args !== 'object' || args === null || Object.keys(args).length > 0)
      ) {
        return Promise.resolve(failWith('invalid_request', 'status takes no arguments'));
      }
      const c = engine.ceiling;
      return Promise.resolve(
        text({
          ...engine.status(),
          ceiling: {
            limits: c.limits,
            network_allow: c.networkAllow,
            network_ports: c.networkPorts,
            require_at_least: c.requireAtLeast,
            max_sessions: c.maxSessions,
            session_idle_s: c.sessionIdleS,
          },
        }),
      );
    },
  };

  const diff: ToolDef = {
    name: 'diff',
    title: 'Show what a session changed',
    description:
      'Show everything the program changed in a session compared with the files it started from: each ' +
      'path, whether it was added, modified or deleted, its size and SHA-256, and a patch for small text ' +
      'files. The result includes `changes_sha256`, which you must pass to `commit` so that exactly ' +
      'what was reviewed is applied. Read-only.',
    inputSchema: inputSchemaOf(sessionArgs),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    call(args) {
      const a = sessionArgs.safeParse(args);
      if (!a.success) return Promise.resolve(argProblem(a.error));
      const d = engine.diff(a.data.session);
      return Promise.resolve(d.ok ? text(d.value) : fail(d.error.code));
    },
  };

  const commit: ToolDef = {
    name: 'commit',
    title: 'Apply approved changes to the real project',
    description:
      'Write the listed paths from a session into the real project. This changes files outside the cell, ' +
      'so a person should approve it. You must list the paths to apply and pass `expected_changes_sha256` ' +
      'from the latest `diff`; if the session changed since, nothing is written and the current diff is ' +
      'returned. Git hooks, symlinks, device files, set-uid files and anything outside the project are ' +
      "always refused, and deletions are reported but not applied. The destination is the session's own " +
      '`workspace.source`; a session made only from `files` needs `dest`, which must be in the policy.',
    inputSchema: inputSchemaOf(commitArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async call(args) {
      const a = commitArgs.safeParse(args);
      if (!a.success) return argProblem(a.error);
      const r = await engine.commit(a.data.session, {
        paths: a.data.paths,
        expectedChangesSha256: a.data.expected_changes_sha256,
        ...(a.data.dest === undefined ? {} : { dest: a.data.dest }),
        ...(a.data.close === undefined ? {} : { close: a.data.close }),
      });
      if (!r.ok) return fail(r.error.code);
      if (r.value.kind === 'stale') {
        return failWith(
          'stale_diff',
          'the session changed since the diff you approved; review this one',
          {
            diff: r.value.diff,
          },
        );
      }
      return text(r.value);
    },
  };

  const discard: ToolDef = {
    name: 'discard',
    title: 'Throw a session away',
    description:
      'Delete a session and everything its programs changed, without touching the real project. Sessions ' +
      'also expire when idle.',
    inputSchema: inputSchemaOf(sessionArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    call(args) {
      const a = sessionArgs.safeParse(args);
      if (!a.success) return Promise.resolve(argProblem(a.error));
      const d = engine.discard(a.data.session);
      return Promise.resolve(
        d.ok ? text({ session: a.data.session, discarded: true }) : fail(d.error.code),
      );
    },
  };

  return [run, status, diff, commit, discard];
}
