// Small typed parsers for the output of probe payloads (`name-rc=N` lines from shell scripts and
// `label rc errno` lines from the Python/ctypes ones), so the probes assert on values, not text.

export function exitCodes(out: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const m of out.matchAll(/(\w[\w-]*)-rc=(\d+)/g)) {
    const key = m[1];
    const value = m[2];
    if (key !== undefined && value !== undefined) result[key] = Number(value);
  }
  return result;
}

export interface SyscallResult {
  readonly rc: number;
  readonly errno: number;
}

export function syscallResults(out: string): Record<string, SyscallResult> {
  const result: Record<string, SyscallResult> = {};
  for (const m of out.matchAll(/^([\w-]+) (-?\d+) (\d+)$/gm)) {
    const key = m[1];
    const rc = m[2];
    const errno = m[3];
    if (key !== undefined && rc !== undefined && errno !== undefined) {
      result[key] = { rc: Number(rc), errno: Number(errno) };
    }
  }
  return result;
}
