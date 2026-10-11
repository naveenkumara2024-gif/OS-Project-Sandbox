import { spawn } from 'node:child_process';
import { Duplex, type Readable, type Writable } from 'node:stream';
import { CappedBuffer } from '../util/capped-buffer.js';
import { err, errFromException, ok, type Result } from '../util/result.js';

// Host-side supervision of one `aegis-cell boot` (CLAUDE.md 5.2): one event loop, timers, bounded
// readers. Descriptor layout is fixed (native/src/boot.c): 3 spec in, 4 status out, 5 control in.

export interface SuperviseOptions {
  /** Absolute path of aegis-cell. */
  readonly helper: string;
  readonly spec: Uint8Array;
  readonly wallMs: number;
  /** Cap applied to each of stdout and stderr. */
  readonly maxOutputBytes: number;
  /** How long the helper gets to act on the kill request before it is SIGKILLed itself. */
  readonly graceMs?: number;
}

export interface SuperviseOutcome {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly status: string;
  readonly timedOut: boolean;
  readonly outputLimit: 'stdout' | 'stderr' | null;
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
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
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
    let timedOut = false;
    let outputLimit: 'stdout' | 'stderr' | null = null;
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
      if (!controlStream.destroyed && controlStream.writable) {
        controlStream.write('K');
      }
      // The helper normally kills the cell through its pidfd and exits. This is the backstop.
      graceTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, grace);
    };

    const wallTimer = setTimeout(() => {
      timedOut = true;
      requestKill();
    }, opts.wallMs);
    const hardTimer = setTimeout(
      () => {
        child.kill('SIGKILL');
      },
      opts.wallMs + grace + HARD_SLACK_MS,
    );

    out.on('data', (chunk: Buffer) => {
      if (!stdout.push(chunk) && outputLimit === null) {
        outputLimit = 'stdout';
        requestKill();
      }
    });
    errStream.on('data', (chunk: Buffer) => {
      if (!stderr.push(chunk) && outputLimit === null) {
        outputLimit = 'stderr';
        requestKill();
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
      if (graceTimer !== null) clearTimeout(graceTimer);
      resolve(errFromException(e, 'spawn aegis-cell'));
    });

    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      clearTimeout(hardTimer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      resolve(
        ok({
          stdout: stdout.toBuffer(),
          stderr: stderr.toBuffer(),
          status: status.toBuffer().toString('utf8'),
          timedOut,
          outputLimit,
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
