import { execFile } from 'node:child_process';
import { errFromException, ok, type Result } from '../util/result.js';

// Converts a Windows path to its WSL form at the ingest/commit border only (CLAUDE.md 6.3).
// Always an argument array, never a shell (CLAUDE.md 6.2).

const WINDOWS_PATH = /^[A-Za-z]:[\\/]|^\\\\/;

export function looksLikeWindowsPath(path: string): boolean {
  return WINDOWS_PATH.test(path);
}

export function wslpathToLinux(windowsPath: string): Promise<Result<string>> {
  return new Promise((resolve) => {
    if (windowsPath.includes('\0')) {
      resolve(errFromException(new Error('NUL byte in path'), 'wslpath'));
      return;
    }
    execFile('/usr/bin/wslpath', ['-u', windowsPath], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve(errFromException(error, 'wslpath -u'));
        return;
      }
      resolve(ok(stdout.replace(/\n$/, '')));
    });
  });
}
