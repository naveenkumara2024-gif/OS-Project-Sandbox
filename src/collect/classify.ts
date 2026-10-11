import { constants } from 'node:os';
import type { StatusRecord } from '../sys/status.js';

// Stage 1 subset of the termination classifier (CLAUDE.md 1.2 item 3). oom, pids_limit and
// disk_limit need cgroups and arrive in Stage 2.

export type Termination =
  | { readonly cause: 'exit' }
  | { readonly cause: 'timeout' }
  | { readonly cause: 'output_limit'; readonly stream: 'stdout' | 'stderr' }
  | { readonly cause: `signal:${string}` }
  | { readonly cause: 'isolation_unavailable'; readonly layer: string; readonly errno: number }
  | { readonly cause: 'internal_error' };

export interface Facts {
  readonly records: readonly StatusRecord[];
  readonly timedOut: boolean;
  readonly outputLimit: 'stdout' | 'stderr' | null;
}

export interface Classified {
  readonly termination: Termination;
  /** The payload's exit status, or null when it did not exit normally or never ran. */
  readonly exitCode: number | null;
}

const SIGNAL_NAMES = new Map<number, string>(
  Object.entries(constants.signals).map(([name, num]) => [num, name]),
);

export function signalName(n: number): string {
  return SIGNAL_NAMES.get(n) ?? `SIG${String(n)}`;
}

export function errnoName(n: number): string {
  for (const [name, num] of Object.entries(constants.errno)) {
    if (num === n) return name;
  }
  return `E${String(n)}`;
}

/**
 * Precedence: a layer failure before the payload started is the answer; otherwise what the
 * supervisor did to the cell (timeout, output cap) outranks how the payload then died, because
 * the kill is the cause and the SIGKILL is only its effect.
 */
export function classify(f: Facts): Classified {
  const started = f.records.some((r) => r.kind === 'started');
  if (!started) {
    for (const r of f.records) {
      if (r.kind === 'layer' && !r.ok) {
        return {
          termination: { cause: 'isolation_unavailable', layer: r.layer, errno: r.errno },
          exitCode: null,
        };
      }
    }
    return { termination: { cause: 'internal_error' }, exitCode: null };
  }
  const exited = f.records.find((r) => r.kind === 'exited');
  const signaled = f.records.find((r) => r.kind === 'signaled');
  const exitCode = exited?.kind === 'exited' ? exited.code : null;
  if (f.timedOut) {
    return { termination: { cause: 'timeout' }, exitCode };
  }
  if (f.outputLimit !== null) {
    return { termination: { cause: 'output_limit', stream: f.outputLimit }, exitCode };
  }
  if (exited?.kind === 'exited') {
    return { termination: { cause: 'exit' }, exitCode: exited.code };
  }
  if (signaled?.kind === 'signaled') {
    return { termination: { cause: `signal:${signalName(signaled.signal)}` }, exitCode: null };
  }
  return { termination: { cause: 'internal_error' }, exitCode: null };
}
