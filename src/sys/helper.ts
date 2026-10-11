import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, errFromException, ok, okVoid, type Result } from '../util/result.js';
import { runBounded } from './run-bounded.js';

/** Facts reported by `aegis-cell probe`, in the same order the helper emits them. */
export const NATIVE_FACT_KEYS = [
  'clone3',
  'openat2_resolve_beneath',
  'pidfd_open',
  'landlock_abi_version',
  'seccomp_mode',
  'no_new_privs',
  'unshare_newuser',
] as const;

export type NativeFactKey = (typeof NATIVE_FACT_KEYS)[number];

export interface NativeFact {
  readonly value: boolean | number | null;
  readonly source: string;
  /** Raw errno number from the helper, or null when the call succeeded. */
  readonly errno: number | null;
}

export interface HelperProbe {
  readonly helperVersion: string;
  readonly facts: Readonly<Record<NativeFactKey, NativeFact>>;
}

export interface HelperLocation {
  readonly path: string;
  readonly source: string;
}

/** Directory of this module, used to find the repository root without relying on the CWD. */
export function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Walks up from `startDir` to the directory holding both package.json and native/. */
export function findRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'native'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Locates the helper binary. `AEGIS_CELL_BIN` (absolute path) overrides the default
 * `<repo>/native/build/release/aegis-cell`; the chosen path and its source are reported in the probe
 * output so an override is always visible.
 */
export function locateHelper(
  env: Readonly<Record<string, string | undefined>>,
  startDir: string,
): Result<HelperLocation> {
  const override = env['AEGIS_CELL_BIN'];
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override)) {
      return err('EINVAL', 'AEGIS_CELL_BIN must be an absolute path');
    }
    return ok({ path: override, source: 'env:AEGIS_CELL_BIN' });
  }
  const root = findRepoRoot(startDir);
  if (root === null) {
    return err('ENOENT', 'repository root not found');
  }
  return ok({
    path: join(root, 'native', 'build', 'release', 'aegis-cell'),
    source: 'repo:native/build/release',
  });
}

export function checkExecutable(path: string): Result<void> {
  try {
    accessSync(path, constants.X_OK);
    return okVoid;
  } catch (e) {
    return errFromException(e, 'access X_OK');
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sameKeys(actual: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(actual).sort();
  const want = [...expected].sort();
  return keys.length === want.length && keys.every((k, i) => k === want[i]);
}

function readFact(v: unknown, name: string): Result<NativeFact> {
  if (!isRecord(v) || !sameKeys(v, ['value', 'source', 'errno'])) {
    return err('EPROTO', `fact ${name} has the wrong shape`);
  }
  const value = v['value'];
  const source = v['source'];
  const errno = v['errno'];
  if (value !== null && typeof value !== 'boolean' && typeof value !== 'number') {
    return err('EPROTO', `fact ${name} has an invalid value`);
  }
  if (typeof source !== 'string') {
    return err('EPROTO', `fact ${name} has an invalid source`);
  }
  if (errno !== null && (typeof errno !== 'number' || !Number.isInteger(errno))) {
    return err('EPROTO', `fact ${name} has an invalid errno`);
  }
  return ok({ value, source, errno });
}

/**
 * Validates the helper's single JSON line. The helper is trusted code, but its output crosses a
 * process boundary, so it is checked like any other external input: exact key set, exact types.
 */
export function parseHelperProbe(text: string): Result<HelperProbe> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return errFromException(e, 'helper output is not JSON');
  }
  if (!isRecord(parsed) || !sameKeys(parsed, ['schema', 'helper', 'helper_version', 'facts'])) {
    return err('EPROTO', 'helper output has the wrong top-level shape');
  }
  if (parsed['schema'] !== 1 || parsed['helper'] !== 'aegis-cell') {
    return err('EPROTO', 'helper output has an unknown schema or helper name');
  }
  const version = parsed['helper_version'];
  if (typeof version !== 'string') {
    return err('EPROTO', 'helper_version is not a string');
  }
  const facts = parsed['facts'];
  if (!isRecord(facts) || !sameKeys(facts, NATIVE_FACT_KEYS)) {
    return err('EPROTO', 'helper facts have the wrong key set');
  }

  const clone3 = readFact(facts['clone3'], 'clone3');
  if (!clone3.ok) return clone3;
  const openat2 = readFact(facts['openat2_resolve_beneath'], 'openat2_resolve_beneath');
  if (!openat2.ok) return openat2;
  const pidfd = readFact(facts['pidfd_open'], 'pidfd_open');
  if (!pidfd.ok) return pidfd;
  const landlock = readFact(facts['landlock_abi_version'], 'landlock_abi_version');
  if (!landlock.ok) return landlock;
  const seccomp = readFact(facts['seccomp_mode'], 'seccomp_mode');
  if (!seccomp.ok) return seccomp;
  const nnp = readFact(facts['no_new_privs'], 'no_new_privs');
  if (!nnp.ok) return nnp;
  const userns = readFact(facts['unshare_newuser'], 'unshare_newuser');
  if (!userns.ok) return userns;

  return ok({
    helperVersion: version,
    facts: {
      clone3: clone3.value,
      openat2_resolve_beneath: openat2.value,
      pidfd_open: pidfd.value,
      landlock_abi_version: landlock.value,
      seccomp_mode: seccomp.value,
      no_new_privs: nnp.value,
      unshare_newuser: userns.value,
    },
  });
}

/** Runs `aegis-cell probe` with an empty environment and validates its output. */
export async function runHelperProbe(path: string, timeoutMs = 5000): Promise<Result<HelperProbe>> {
  const r = await runBounded({
    file: path,
    args: ['probe'],
    env: {},
    timeoutMs,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 16 * 1024,
  });
  if (!r.ok) return r;
  const outcome = r.value;
  if (outcome.timedOut) {
    return err('ETIMEDOUT', 'helper probe timed out');
  }
  if (outcome.outputLimit !== null) {
    return err('EFBIG', `helper probe exceeded the ${outcome.outputLimit} cap`);
  }
  if (outcome.exitCode !== 0) {
    return err('EPROTO', `helper probe exited with ${String(outcome.exitCode ?? outcome.signal)}`);
  }
  return parseHelperProbe(outcome.stdout.toString('utf8'));
}
