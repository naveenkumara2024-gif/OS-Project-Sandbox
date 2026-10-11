import { describe, expect, it } from 'vitest';
import {
  PROBE_FACT_KEYS,
  collectProbe,
  errnoName,
  realProbeEnv,
  type HelperOutcome,
  type ProbeEnv,
} from '../../src/probe/probe.js';
import { parseHelperProbe } from '../../src/sys/helper.js';
import { err, ok, okVoid } from '../../src/util/result.js';

const HELPER_LINE = JSON.stringify({
  schema: 1,
  helper: 'aegis-cell',
  helper_version: '0.0.0',
  facts: {
    clone3: { value: true, source: 'syscall:clone3(size=0)', errno: 22 },
    openat2_resolve_beneath: { value: true, source: 'syscall:openat2', errno: null },
    pidfd_open: { value: true, source: 'syscall:pidfd_open(self)', errno: null },
    landlock_abi_version: { value: null, source: 'syscall:landlock', errno: 38 },
    seccomp_mode: { value: 0, source: 'prctl:PR_GET_SECCOMP', errno: null },
    no_new_privs: { value: 0, source: 'prctl:PR_GET_NO_NEW_PRIVS', errno: null },
    unshare_newuser: { value: true, source: 'fork+unshare(CLONE_NEWUSER)', errno: null },
  },
});

const CG = '/sys/fs/cgroup/user.slice/s.scope';

const FILES: Record<string, string> = {
  '/proc/version': 'Linux version 5.15.0-test (gcc)\n',
  '/proc/sys/kernel/osrelease': '5.15.0-test-microsoft-standard-WSL2\n',
  '/proc/sys/user/max_user_namespaces': '63548\n',
  '/proc/self/mountinfo': '34 22 0:29 / /sys/fs/cgroup rw - cgroup2 cgroup2 rw\n',
  '/proc/self/cgroup': '0::/user.slice/s.scope\n',
  [`${CG}/cgroup.controllers`]: 'memory pids\n',
  [`${CG}/cgroup.subtree_control`]: 'pids\n',
  [`${CG}/cgroup.procs`]: '',
  [`${CG}/cgroup.kill`]: '',
  '/proc/filesystems': 'nodev\toverlay\n\text4\n',
};

function fakeEnv(files: Record<string, string>, helper?: HelperOutcome): ProbeEnv {
  const map = new Map(Object.entries(files));
  const parsed = parseHelperProbe(HELPER_LINE);
  return {
    readText: (p) => {
      const t = map.get(p);
      return t === undefined ? err('ENOENT', p) : ok(t);
    },
    listDir: (p) =>
      p === '/proc/sys/fs/binfmt_misc'
        ? ok(['register', 'status', 'WSLInterop', 'python3.12'])
        : err('ENOENT', p),
    exists: (p) => map.has(p) || p === '/mnt/c',
    isWritable: (p) => (map.has(p) ? okVoid : err('EACCES', p)),
    statfsType: () => ok(0xef53),
    osRelease: () => '5.15.0-test-microsoft-standard-WSL2',
    arch: () => 'x64',
    nodeVersion: () => '22.0.0',
    uid: () => 1000,
    gid: () => 1000,
    cwd: () => '/home/u/aegis',
    now: () => new Date(0),
    helperProbe: () =>
      Promise.resolve(helper ?? { path: '/fake/aegis-cell', source: 'test', result: parsed }),
  };
}

describe('collectProbe', () => {
  it('reports every documented fact and no others', async () => {
    const report = await collectProbe(fakeEnv(FILES));
    expect(Object.keys(report.facts).sort()).toEqual([...PROBE_FACT_KEYS].sort());
    expect(report.schema).toBe(1);
    expect(report.generated_at).toBe('1970-01-01T00:00:00.000Z');
  });

  it('records values, sources and errno names from the environment', async () => {
    const f = (await collectProbe(fakeEnv(FILES))).facts;
    expect(f['cgroup2.mount_point'].value).toBe('/sys/fs/cgroup');
    expect(f['cgroup.self_path'].value).toBe('/user.slice/s.scope');
    expect(f['cgroup.controllers'].value).toEqual(['memory', 'pids']);
    expect(f['cgroup.subtree_control'].value).toEqual(['pids']);
    expect(f['cgroup.own_dir_writable'].value).toBe(true);
    expect(f['cgroup.kill_present'].value).toBe(true);
    expect(f['cgroup.memory_peak_present'].value).toBe(false);
    expect(f['fs.overlay_listed'].value).toBe(true);
    expect(f['userns.max_user_namespaces'].value).toBe(63548);
    expect(f['wsl.osrelease_marker'].value).toBe(true);
    expect(f['wsl.interop_entries'].value).toEqual(['WSLInterop']);
    expect(f['mnt_c.present'].value).toBe(true);
    expect(f['cwd.statfs_type'].value).toBe(0xef53);
    expect(f['native.clone3']).toEqual({
      value: true,
      source: 'syscall:clone3(size=0)',
      errno: errnoName(22),
    });
    expect(f['native.landlock_abi_version'].value).toBeNull();
    expect(f['native.landlock_abi_version'].errno).toBe(errnoName(38));
  });

  it('keeps failures visible instead of dropping facts', async () => {
    const f = (await collectProbe(fakeEnv({}))).facts;
    expect(f['kernel.version'].value).toBeNull();
    expect(f['kernel.version'].errno).toBe('ENOENT');
    expect(f['cgroup.controllers'].value).toBeNull();
    expect(f['cgroup.controllers'].source).toMatch(/^skipped:/);
  });

  it('reports an unavailable helper as facts, not as a failure', async () => {
    const helper: HelperOutcome = {
      path: '/fake/aegis-cell',
      source: 'test',
      result: err('ENOENT', 'access X_OK'),
    };
    const f = (await collectProbe(fakeEnv(FILES, helper))).facts;
    expect(f['native.helper_available'].value).toBe(false);
    expect(f['native.helper_available'].errno).toBe('ENOENT');
    expect(f['native.clone3'].value).toBeNull();
    expect(f['native.clone3'].source).toMatch(/^skipped:/);
  });
});

describe('errnoName', () => {
  it('maps known numbers and labels unknown ones', () => {
    expect(errnoName(2)).toBe('ENOENT');
    expect(errnoName(99999)).toBe('ERRNO_99999');
  });
});

describe('realProbeEnv smoke test', () => {
  it('produces a complete, JSON-serialisable report on this machine', async () => {
    const report = await collectProbe(realProbeEnv());
    // Asserts shape only: it must not assert that any kernel feature is supported (CLAUDE.md 3.1).
    expect(Object.keys(report.facts).sort()).toEqual([...PROBE_FACT_KEYS].sort());
    const roundTrip: unknown = JSON.parse(JSON.stringify(report));
    expect(roundTrip).toEqual(report);
  });
});
