import { spawn } from 'node:child_process';
import { Duplex, type Readable, type Writable } from 'node:stream';
import type { SupervisorKill } from '../collect/classify.js';
import { CappedBuffer } from '../util/capped-buffer.js';
import { err, errFromException, ok, type Result } from '../util/result.js';

// Host-side supervision of one `aegis-cell boot` (CLAUDE.md 5.2): one event loop, timers, bounded
// readers. Descriptor layout is fixed (native/src/boot.c): 3 spec in, 4 status out, 5 control in.

/** What the supervisor's poll hook can ask for. */
export type PollVerdict =
  { readonly kind: 'timeout'; readonly clock: 'cpu' } | { readonly kind: 'pids_limit' };

export interface SuperviseOptions {
  /** Absolute path of aegis-cell. */
  readonly helper: string;
  readonly spec: Uint8Array;
  readonly wallMs: number;
  /** Cap applied to each of stdout and stderr. */
  readonly maxOutputBytes: number;
  /** How long the helper gets to act on the kill request before it is SIGKILLed itself. */
  readonly graceMs?: number;
  /** Descriptor 6: the cell's cgroup directory (CLONE_INTO_CGROUP). Absent in Stage 1 style runs. */
  readonly cgroupFd?: number;
  /** Called every `pollMs`; a verdict makes the supervisor kill the cell for that reason. */
  readonly poll?: () => PollVerdict | null;
  readonly pollMs?: number;
  /** Kills every process in the cell directly (cgroup.kill); the helper kill stays as a backstop. */
  readonly killCell?: () => void;
}

export interface SuperviseOutcome {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly status: string;
  /** What the supervisor itself did to end the run, if anything. */
  readonly killedFor: SupervisorKill | null;
  readonly helperExitCode: number | null;
  readonly helperSignal: NodeJS.Signals | null;
  readonly wallMs: number;
}

const STATUS_CAP = 64 * 1024;
const DEFAULT_GRACE_MS = 2000;
/** Extra time after the wall-clock limit before giving up on a helper that will not exit. */
const HARD_SLACK_MS = 3000;

export function superviseCell(opts: SuperviseOptions): Promise<Result<SuperviseOutcome>> {
  const grace = opts.graceMs ?? DEFAULT_GRACE_MS;

  return new Promise<Result<SuperviseOutcome>>((resolve) => {
    const started = performance.now();
    let child;
    try {
      child = spawn(opts.helper, ['boot'], {
        shell: false,
        // The helper needs no environment, and nothing of ours is passed on (CLAUDE.md 6.1 item 5).
        env: {},
        stdio: [
          'ignore',
          'pipe',
          'pipe',
          'pipe',
          'pipe',
          'pipe',
          ...(opts.cgroupFd === undefined ? [] : [opts.cgroupFd]),
        ],
        windowsHide: true,
      });
    } catch (e) {
      resolve(errFromException(e, 'spawn aegis-cell'));
      return;
    }

    // The stdio tuple type only covers descriptors 0 to 4 for this overload; the array form is the
    // honest type for the fixed six-entry layout.
    const streams: readonly (Readable | Writable | null | undefined)[] = child.stdio;
    const specStream = streams[3];
    const statusStream = streams[4];
    const controlStream = streams[5];
    const out = child.stdout;
    const errStream = child.stderr;
    if (
      !(specStream instanceof Duplex) ||
      !(statusStream instanceof Duplex) ||
      !(controlStream instanceof Duplex) ||
      out === null ||
      errStream === null
    ) {
      child.kill('SIGKILL');
      resolve(err('EPROTO', 'helper stdio was not set up'));
      return;
    }

    const stdout = new CappedBuffer(opts.maxOutputBytes);
    const stderr = new CappedBuffer(opts.maxOutputBytes);
    const status = new CappedBuffer(STATUS_CAP);
    let killedFor: SupervisorKill | null = null;
    let killRequested = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | null = null;

    // A helper that dies early closes these sockets under us; that surfaces as EPIPE/ECONNRESET
    // here and is then visible in the status stream and exit status, so it is not fatal by itself.
    const ignoreStreamError = (): void => undefined;
    specStream.on('error', ignoreStreamError);
    statusStream.on('error', ignoreStreamError);
    controlStream.on('error', ignoreStreamError);

    const requestKill = (): void => {
      if (killRequested) return;
      killRequested = true;
      // cgroup.kill first: it ends init and everything it spawned in one step, however they
      // behave. The helper's own kill below is the backstop if that write is unavailable.
      opts.killCell?.();
      if (!controlStream.destroyed && controlStream.writable) {
        controlStream.write('K');
      }
      // The helper normally kills the cell through its pidfd and exits. This is the backstop.
      graceTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, grace);
    };

    const kill = (why: SupervisorKill): void => {
      killedFor ??= why;
      requestKill();
    };

    const wallTimer = setTimeout(() => {
      kill({ kind: 'timeout', clock: 'wall' });
    }, opts.wallMs);
    const pollTimer =
      opts.poll === undefined
        ? null
        : setInterval(() => {
            const v = opts.poll?.() ?? null;
            if (v !== null) kill(v);
          }, opts.pollMs ?? 25);
    const hardTimer = setTimeout(
      () => {
        child.kill('SIGKILL');
      },
      opts.wallMs + grace + HARD_SLACK_MS,
    );

    out.on('data', (chunk: Buffer) => {
      if (!stdout.push(chunk)) {
        kill({ kind: 'output_limit', stream: 'stdout' });
      }
    });
    errStream.on('data', (chunk: Buffer) => {
      if (!stderr.push(chunk)) {
        kill({ kind: 'output_limit', stream: 'stderr' });
      }
    });
    statusStream.on('data', (chunk: Buffer) => {
      status.push(chunk);
    });

    child.once('error', (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      clearTimeout(hardTimer);
      if (pollTimer !== null) clearInterval(pollTimer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      resolve(errFromException(e, 'spawn aegis-cell'));
    });

    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      clearTimeout(hardTimer);
      if (pollTimer !== null) clearInterval(pollTimer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      resolve(
        ok({
          stdout: stdout.toBuffer(),
          stderr: stderr.toBuffer(),
          status: status.toBuffer().toString('utf8'),
          killedFor,
          helperExitCode: code,
          helperSignal: signal,
          wallMs: Math.round(performance.now() - started),
        }),
      );
    });

    // Written last: the helper reads until EOF, so the spec must be complete before end().
    specStream.end(Buffer.from(opts.spec));
  });
}
