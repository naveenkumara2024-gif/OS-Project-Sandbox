import { mkdirSync, mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, errFromException, ok, type Result } from './result.js';

/**
 * A private per-cell directory, removed when disposed (CLAUDE.md 5.1).
 *
 * Removal is deliberately `rmdir`, never recursive: while a cell runs, its bind mounts live in a
 * private mount namespace and are invisible here, but a recursive delete over a path that ever
 * had a mount stacked on it is exactly the mistake a sandbox must not be able to make.
 */
export class TempDir implements Disposable {
  readonly path: string;
  readonly #children: string[] = [];
  #disposed = false;

  private constructor(path: string) {
    this.path = path;
  }

  static create(prefix: string, parent: string = tmpdir()): Result<TempDir> {
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(prefix)) {
      return err('EINVAL', 'temp dir prefix has unexpected characters');
    }
    try {
      const path = mkdtempSync(join(parent, `${prefix}-`));
      return ok(new TempDir(path));
    } catch (e) {
      return errFromException(e, 'mkdtemp');
    }
  }

  /** Creates an empty subdirectory (mode 0700) and remembers it for disposal. */
  mkdir(name: string): Result<string> {
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(name) || name === '.' || name === '..') {
      return err('EINVAL', 'temp subdirectory name has unexpected characters');
    }
    const p = join(this.path, name);
    try {
      mkdirSync(p, { mode: 0o700 });
      this.#children.push(p);
      return ok(p);
    } catch (e) {
      return errFromException(e, `mkdir ${name}`);
    }
  }

  [Symbol.dispose](): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const c of this.#children.reverse()) {
      rmdirSync(c);
    }
    rmdirSync(this.path);
  }
}
