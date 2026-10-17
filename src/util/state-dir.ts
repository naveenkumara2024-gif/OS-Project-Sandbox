import { lstatSync, mkdirSync } from 'node:fs';
import { err, errFromException, ok, type Result } from './result.js';

// A directory that holds a socket or a log must be ours alone. Created `0700`; an existing one is
// accepted only if it is a real directory (not a symlink) owned by this user with no group or
// other permission bits, because a looser directory would let another account replace the socket.

export function ensurePrivateDir(
  path: string,
  uid: number = process.getuid?.() ?? -1,
): Result<void> {
  try {
    let st;
    try {
      st = lstatSync(path);
    } catch (e) {
      if (typeof e === 'object' && e !== null && Reflect.get(e, 'code') === 'ENOENT') {
        mkdirSync(path, { mode: 0o700 });
        st = lstatSync(path);
      } else {
        throw e;
      }
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return err('ENOTDIR', 'the state directory is not a real directory');
    }
    if (st.uid !== uid) {
      return err('EACCES', 'the state directory is not owned by this user');
    }
    if ((st.mode & 0o077) !== 0) {
      return err('EACCES', 'the state directory is accessible to other users (must be 0700)');
    }
    return ok(undefined);
  } catch (e) {
    return errFromException(e, 'prepare the state directory');
  }
}
