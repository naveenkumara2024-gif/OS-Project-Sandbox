import { closeSync, constants, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { err, errFromException, ok, type Result } from '../util/result.js';
import { validateInlineFiles, type InlineFile } from './ingest.js';

// Files a later run of a session adds. They are written straight into the overlay's upper layer,
// so they show up in the diff as the changes they are (prompt Stage 5 section 4.2). The upper
// layer is not mounted between runs, so a host write is just a file write; the Stage 5 spike
// measured that the next overlay mount reads such files correctly, over a lower file and in new or
// merged directories.
//
// Not covered by that measurement, and therefore refused: a path whose target or any parent is an
// overlay whiteout (a deleted file or directory). Recreating one correctly needs an opaque marker
// this code cannot write, and a wrong guess would hide a deletion from the diff.

/** A character device 0,0 inside an upper layer is overlayfs's whiteout marker (overlayfs(5)). */
export function isWhiteoutStat(st: { isCharacterDevice(): boolean; rdev: number }): boolean {
  return st.isCharacterDevice() && st.rdev === 0;
}

export interface UpperEntryStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isCharacterDevice(): boolean;
  rdev: number;
}

/** What may sit at an existing upper-layer path that a write has to pass through or replace. */
export function checkUpperEntry(st: UpperEntryStat, last: boolean): Result<void> {
  if (st.isSymbolicLink()) return err('EACCES', 'a symlink is in the way');
  if (isWhiteoutStat(st)) {
    return err('EEXIST', 'the path was deleted in an earlier run (overlay whiteout)');
  }
  if (last) {
    return st.isFile() ? ok(undefined) : err('EEXIST', 'the target exists and is not a file');
  }
  return st.isDirectory() ? ok(undefined) : err('ENOTDIR', 'a parent is not a directory');
}

export function writeFilesToUpper(
  upperDir: string,
  files: readonly InlineFile[],
  lstat: (p: string) => UpperEntryStat | null = (p) => {
    try {
      return lstatSync(p);
    } catch (e) {
      if (typeof e === 'object' && e !== null && Reflect.get(e, 'code') === 'ENOENT') return null;
      throw e;
    }
  },
): Result<void> {
  const valid = validateInlineFiles(files);
  if (!valid.ok) return valid;
  try {
    // Check everything first, so a refused file leaves the upper layer unchanged.
    for (const f of files) {
      const parts = f.path.split('/');
      let cur = upperDir;
      for (let i = 0; i < parts.length; i++) {
        cur = join(cur, parts[i] ?? '');
        const st = lstat(cur);
        if (st === null) break;
        const ok1 = checkUpperEntry(st, i === parts.length - 1);
        if (!ok1.ok) return err(ok1.error.code, `${f.path}: ${ok1.error.context}`);
      }
    }
    for (const f of files) {
      const target = join(upperDir, f.path);
      const slash = target.lastIndexOf('/');
      mkdirSync(target.slice(0, slash), { recursive: true, mode: 0o755 });
      // O_NOFOLLOW: a symlink created between the check and now is refused, not followed.
      const fd = openSync(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o644,
      );
      try {
        writeSync(fd, f.content, null, 'utf8');
      } finally {
        closeSync(fd);
      }
    }
    return ok(undefined);
  } catch (e) {
    return errFromException(e, 'write files into the session workspace');
  }
}
