import { constants } from 'node:os';
import type { StatusRecord } from '../sys/status.js';

// The termination classifier (CLAUDE.md 1.2 item 3; blueprint "Classifying how a run ended").
// It fuses flags the supervisor set itself with kernel counters read after the run.

export type SupervisorKill =
  | { readonly kind: 'timeout'; readonly clock: 'wall' | 'cpu' }
  | { readonly kind: 'output_limit'; readonly stream: 'stdout' | 'stderr' }
  | { readonly kind: 'pids_limit' }
  | { readonly kind: 'disk_limit'; readonly path: string }
  /** The caller asked for the run to stop (gateway cancel, MCP cancellation). */
  | { readonly kind: 'cancelled' };

export type Termination =
  | { readonly cause: 'exit' }
  | { readonly cause: 'timeout'; readonly clock: 'wall' | 'cpu' }
  | { readonly cause: 'cancelled' }
  | { readonly cause: 'oom' }
  | { readonly cause: 'pids_limit' }
  | { readonly cause: 'output_limit'; readonly stream: 'stdout' | 'stderr' }
  | { readonly cause: 'disk_limit'; readonly path: string }
  | { readonly cause: `signal:${string}` }
  | { readonly cause: 'isolation_unavailable'; readonly layer: string; readonly errno: number }
  | { readonly cause: 'exec_failed'; readonly errno: number }
  | { readonly cause: 'internal_error' };

export type LimitHit = 'memory' | 'pids' | 'cpu' | 'wall' | 'output' | 'disk';

export interface Facts {
  readonly records: readonly StatusRecord[];
  /** What the supervisor itself did to end the run, if anything. */
  readonly supervisorKill: SupervisorKill | null;
  /** `oom_kill` from memory.events at the end of the run. */
  readonly oomKills: number;
  /** `max` from pids.events at the end of the run. */
  readonly pidsMaxHits: number;
}

export interface Classified {
  readonly termination: Termination;
  /** The payload's exit status, or null when it did not exit normally or never ran. */
  readonly exitCode: number | null;
  /** Every limit that was reached, so a kill by one cause does not hide another. */
  readonly limitsHit: readonly LimitHit[];
}

// Linux gives some signals two names (SIGABRT/SIGIOT, SIGIO/SIGPOLL, SIGCHLD/SIGCLD); a hint should
// say the one people know, whichever order the table lists them in.
const ALIASES = new Set(['SIGIOT', 'SIGPOLL', 'SIGCLD', 'SIGUNUSED']);
const SIGNAL_NAMES = new Map<number, string>();
for (const [name, num] of Object.entries(constants.signals)) {
  if (!ALIASES.has(name) && !SIGNAL_NAMES.has(num)) {
    SIGNAL_NAMES.set(num, name);
  }
}

export function signalName(n: number): string {
  return SIGNAL_NAMES.get(n) ?? `SIG${String(n)}`;
}

export function errnoName(n: number): string {
  for (const [name, num] of Object.entries(constants.errno)) {
    if (num === n) return name;
  }
  return `E${String(n)}`;
}

export function errnoNumber(code: string): number {
  const n = (constants.errno as Record<string, number | undefined>)[code];
  return n ?? 0;
}

/**
 * Precedence: no payload ran (isolation_unavailable, exec_failed) > what the supervisor did
 * (timeout, output_limit, pids_limit) > the kernel's OOM kill > a full capped tmpfs with a failing
 * payload (disk_limit) > the payload's own signal > a normal exit. A kill is the cause and the
 * SIGKILL it produced is only its effect.
 */
export function classify(f: Facts): Classified {
  const limitsHit: LimitHit[] = [];
  if (f.oomKills > 0) limitsHit.push('memory');
  if (f.pidsMaxHits > 0) limitsHit.push('pids');
  const k = f.supervisorKill;
  if (k?.kind === 'timeout') limitsHit.push(k.clock === 'cpu' ? 'cpu' : 'wall');
  if (k?.kind === 'output_limit') limitsHit.push('output');
  if (k?.kind === 'disk_limit') limitsHit.push('disk');

  // An output or pids kill can only come from a payload that is running, even when init was
  // killed before it could write its `started` record (a fast flooder can reach the cap in the
  // gap between the payload's execve and that record).
  const started =
    f.records.some((r) => r.kind === 'started') ||
    k?.kind === 'output_limit' ||
    k?.kind === 'pids_limit' ||
    k?.kind === 'disk_limit';
  if (!started && k?.kind === 'cancelled') {
    return { termination: { cause: 'cancelled' }, exitCode: null, limitsHit };
  }
  if (!started && k?.kind === 'timeout') {
    // The supervisor ended the cell before the payload got going (a very short limit, a loaded
    // machine). Any layer failure records are then consequences of that kill, not causes.
    return { termination: { cause: 'timeout', clock: k.clock }, exitCode: null, limitsHit };
  }
  if (!started) {
    for (const r of f.records) {
      if (r.kind === 'layer' && !r.ok && r.layer === 'exec') {
        // The cell was fully built and the final execve failed: a problem with the command, not
        // with isolation, and it must not be reported as a missing layer.
        return {
          termination: { cause: 'exec_failed', errno: r.errno },
          exitCode: null,
          limitsHit,
        };
      }
    }
    // The *last* failed layer is the one that stopped the cell: a fatal failure is the final layer
    // record before the process exits, whereas optional layers (overlay falling back to a copy,
    // landlock that was not required) report a failure and the cell goes on.
    const failed = f.records.filter((r) => r.kind === 'layer' && !r.ok);
    const last = failed[failed.length - 1];
    if (last !== undefined) {
      return {
        termination: { cause: 'isolation_unavailable', layer: last.layer, errno: last.errno },
        exitCode: null,
        limitsHit,
      };
    }
    return { termination: { cause: 'internal_error' }, exitCode: null, limitsHit };
  }

  const exited = f.records.find((r) => r.kind === 'exited');
  const signaled = f.records.find((r) => r.kind === 'signaled');
  const full = f.records.find((r) => r.kind === 'full');
  const exitCode = exited?.kind === 'exited' ? exited.code : null;
  const failed = !(exited?.kind === 'exited' && exited.code === 0);
  if (full?.kind === 'full') limitsHit.push('disk');

  if (k !== null) {
    if (k.kind === 'cancelled') return { termination: { cause: 'cancelled' }, exitCode, limitsHit };
    if (k.kind === 'timeout')
      return { termination: { cause: 'timeout', clock: k.clock }, exitCode, limitsHit };
    if (k.kind === 'output_limit') {
      return { termination: { cause: 'output_limit', stream: k.stream }, exitCode, limitsHit };
    }
    if (k.kind === 'disk_limit') {
      return { termination: { cause: 'disk_limit', path: k.path }, exitCode, limitsHit };
    }
    return { termination: { cause: 'pids_limit' }, exitCode, limitsHit };
  }
  if (f.oomKills > 0) {
    return { termination: { cause: 'oom' }, exitCode, limitsHit };
  }
  if (full?.kind === 'full' && failed) {
    return { termination: { cause: 'disk_limit', path: full.path }, exitCode, limitsHit };
  }
  if (exited?.kind === 'exited') {
    return { termination: { cause: 'exit' }, exitCode: exited.code, limitsHit };
  }
  if (signaled?.kind === 'signaled') {
    return {
      termination: { cause: `signal:${signalName(signaled.signal)}` },
      exitCode: null,
      limitsHit,
    };
  }
  return { termination: { cause: 'internal_error' }, exitCode: null, limitsHit };
}

export interface HintLimits {
  readonly wallMs: number;
  readonly cpuMs: number;
  readonly memoryMb: number;
  readonly pids: number;
  readonly outputKb: number;
  readonly diskMb: number;
}

/** One line a harness or a person can act on. Never contains payload data. */
export function hintFor(t: Termination, l: HintLimits): string | null {
  switch (t.cause) {
    case 'exit':
      return null;
    case 'timeout':
      return t.clock === 'cpu'
        ? `used more than the ${String(l.cpuMs)} ms CPU budget; the program was spinning or the work is too large`
        : `ran past the ${String(l.wallMs)} ms wall-clock limit; it may be waiting or doing too much`;
    case 'cancelled':
      return 'the run was cancelled by the caller';
    case 'oom':
      return `killed at the ${String(l.memoryMb)} MB memory limit; reduce the working set or ask for a higher limit`;
    case 'pids_limit':
      return `reached the ${String(l.pids)} process limit; check for a fork loop or too many threads`;
    case 'output_limit':
      return `wrote more than ${String(l.outputKb)} KB to ${t.stream}; print less or write to a file`;
    case 'disk_limit':
      return `${t.path} is capped (${t.path === '/tmp' ? `${String(l.diskMb)} MB` : 'small'}) and was full when the program failed`;
    case 'exec_failed':
      return `the command could not be executed (${errnoName(t.errno)}); check the path inside the cell`;
    case 'isolation_unavailable':
      return t.layer === 'cgroup_placement'
        ? 'the engine is not inside a cgroup delegated to this user; start it with: systemd-run --user --scope --quiet --collect -- node dist/main.js run'
        : `the required isolation layer "${t.layer}" could not be established; the command was not run`;
    case 'internal_error':
      return 'the cell ended without a usable report; this is an engine problem, not the command';
    default:
      if (t.cause === 'signal:SIGSYS') {
        return 'killed by SIGSYS: the seccomp filter rejected a system call from an unsupported architecture or ABI';
      }
      return `ended by ${t.cause.slice('signal:'.length)}`;
  }
}
