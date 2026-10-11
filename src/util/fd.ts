import { closeSync, openSync } from 'node:fs';
import { errFromException, ok, okVoid, type Result } from './result.js';

/**
 * Owns exactly one file descriptor and closes it exactly once (CLAUDE.md 5.1: disposable guards).
 * This class is the only place in the control plane that calls `closeSync`.
 */
export class OwnedFd implements Disposable {
  #fd: number | null;

  private constructor(fd: number) {
    this.#fd = fd;
  }

  /** Takes ownership of a descriptor obtained elsewhere. */
  static adopt(fd: number): OwnedFd {
    return new OwnedFd(fd);
  }

  static open(path: string, flags: number, mode?: number): Result<OwnedFd> {
    try {
      const fd = mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
      return ok(new OwnedFd(fd));
    } catch (e) {
      return errFromException(e, `open ${path}`);
    }
  }

  get isOpen(): boolean {
    return this.#fd !== null;
  }

  /** Using a closed descriptor is a programmer error, so it throws. */
  get fd(): number {
    if (this.#fd === null) {
      throw new Error('OwnedFd used after close or release');
    }
    return this.#fd;
  }

  /** Gives up ownership without closing, for handing the descriptor to a child via stdio. */
  release(): number {
    const fd = this.fd;
    this.#fd = null;
    return fd;
  }

  /** Idempotent. The descriptor is forgotten before closing and never retried: on Linux it is
   * released even when close(2) reports an error (close(2) NOTES), so a retry could hit a reused fd. */
  close(): Result<void> {
    if (this.#fd === null) {
      return okVoid;
    }
    const fd = this.#fd;
    this.#fd = null;
    try {
      closeSync(fd);
      return okVoid;
    } catch (e) {
      return errFromException(e, `close fd ${String(fd)}`);
    }
  }

  [Symbol.dispose](): void {
    const r = this.close();
    if (!r.ok) {
      throw new Error(`${r.error.code}: ${r.error.context}`);
    }
  }
}
