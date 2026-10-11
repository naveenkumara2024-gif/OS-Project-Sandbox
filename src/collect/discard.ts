import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { errFromException, ok, type Result } from '../util/result.js';

// `aegis discard`: removes a cell's whole workspace directory without ever touching the real
// project (the real project root is never named by this function). The directory is one the
// control plane created entirely for this run (lower, rw/upper, rw/work, changes.json), so a
// recursive remove of exactly that directory, and nothing else, is safe.

export interface DiscardDirs {
  readonly dir: string;
}

export function discardWorkspace(dirs: DiscardDirs): Result<void> {
  try {
    // overlayfs creates rw/work/work with mode 0000 (overlayfs(5)); a recursive remove that
    // readdir()s it first (as rmSync does) gets EACCES even though the owner can rmdir it
    // directly. Restoring a normal mode here is enough for the recursive remove to proceed.
    try {
      chmodSync(join(dirs.dir, 'rw', 'work', 'work'), 0o700);
    } catch {
      // Not present (copy mode never created it, or there is nothing to discard); fine either way.
    }
    rmSync(dirs.dir, { recursive: true, force: true });
    return ok(undefined);
  } catch (e) {
    return errFromException(e, 'discard workspace');
  }
}
