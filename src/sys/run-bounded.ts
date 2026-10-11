import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { Readable } from 'node:stream';
import { err, errFromException, ok, type Result } from '../util/result.js';

export interface RunOptions {
  /** Absolute path of the binary. Never resolved through PATH and never run through a shell. */
  readonly file: string;
  readonly args: readonly string[];
  /** The child gets exactly this environment and nothing inherited (CLAUDE.md 6.1 item 5). */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly cwd?: string;
}

export interface RunOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly timedOut: boolean;
  /** Which stream hit its cap, if any. The child is killed when this is set. */
  readonly outputLimit: 'stdout' | 'stderr' | null;
}

/** Accumulates chunks up to a hard cap; excess bytes are dropped, never buffered. */
class CappedBuffer {
  readonly #max: number;
  readonly #chunks: Buffer[] = [];
  #size = 0;
  #overflowed = false;

  constructor(max: number) {
    this.#max = max;
  }

  /** Returns false once the cap has been exceeded. */
  push(chunk: Buffer): boolean {
    if (this.#overflowed) {
      return false;
    }
    const room = this.#max - this.#size;
    if (chunk.length > room) {
      if (room > 0) {
        this.#chunks.push(chunk.subarray(0, room));
        this.#size += room;
      }
      this.#overflowed = true;
      return false;
    }
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    return true;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.#chunks, this.#size);
  }
}

/**
 * Runs a child with an argument vector, an explicit environment, a wall-clock timeout and hard
 * output caps. Template for the Stage 1 supervisor (CLAUDE.md 5.1, 6.2).
 */
export function runBounded(opts: RunOptions): Promise<Result<RunOutcome>> {
  if (!isAbsolute(opts.file)) {
    return Promise.resolve(err('EINVAL', 'binary path must be absolute'));
  }

  return new Promise<Result<RunOutcome>>((resolve) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(opts.file, [...opts.args], {
        shell: false,
        env: { ...opts.env },
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      // spawn throws synchronously for invalid arguments (for example a NUL byte in an argument).
      resolve(errFromException(e, 'spawn'));
      return;
    }

    const stdout = new CappedBuffer(opts.maxStdoutBytes);
    const stderr = new CappedBuffer(opts.maxStderrBytes);
    let timedOut = false;
    let outputLimit: 'stdout' | 'stderr' | null = null;
    let settled = false;

    const kill = (): void => {
      child.kill('SIGKILL');
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (!stdout.push(chunk) && outputLimit === null) {
        outputLimit = 'stdout';
        kill();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (!stderr.push(chunk) && outputLimit === null) {
        outputLimit = 'stderr';
        kill();
      }
    });

    child.once('error', (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(errFromException(e, 'spawn'));
    });

    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        ok({
          exitCode: code,
          signal,
          stdout: stdout.toBuffer(),
          stderr: stderr.toBuffer(),
          timedOut,
          outputLimit,
        }),
      );
    });
  });
}
