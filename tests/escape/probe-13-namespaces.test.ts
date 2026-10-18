import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { helperBuilds, request, runIn, runWith, testGovernance } from '../helpers/cell.js';
import { exitCodes, syscallResults } from '../helpers/parse.js';

// Probe 13 (CLAUDE.md 8.1): nested `unshare` and `setns`. Layer expected to stop it: the seccomp
// filter (unshare, setns, and clone with a namespace flag are refused; clone3 answers ENOSYS so
// libc falls back to clone). Measured in the Stage 4 spike: dropping capabilities does NOT stop
// `unshare -U` (an unprivileged process may create a user namespace and become root in it), so
// seccomp is the layer that matters here and the control below pins that down.

beforeEach(() => {
  vi.stubEnv('AEGIS_TEST_UNSAFE', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const py = [
  'import ctypes, os',
  'libc = ctypes.CDLL(None, use_errno=True)',
  'def call(label, *a):',
  '    ctypes.set_errno(0)',
  '    r = libc.syscall(*a)',
  '    print(label, r, ctypes.get_errno())',
  'CLONE_NEWUSER, CLONE_NEWNS, CLONE_NEWPID, CLONE_NEWNET, SIGCHLD = 0x10000000, 0x20000, 0x20000000, 0x40000000, 17',
  'call("clone-newuser", 56, CLONE_NEWUSER | SIGCHLD, 0, 0, 0, 0)',
  'call("clone-newns", 56, CLONE_NEWNS | SIGCHLD, 0, 0, 0, 0)',
  'call("clone-newpid", 56, CLONE_NEWPID | SIGCHLD, 0, 0, 0, 0)',
  'call("clone-newnet", 56, CLONE_NEWNET | SIGCHLD, 0, 0, 0, 0)',
  'call("clone3", 435, 0, 0)',
  'call("unshare-user", 272, CLONE_NEWUSER)',
  'call("unshare-mnt", 272, CLONE_NEWNS)',
  'fd = os.open("/proc/self/ns/user", os.O_RDONLY)',
  'call("setns-user", 308, fd, CLONE_NEWUSER)',
  'fd = os.open("/proc/self/ns/mnt", os.O_RDONLY)',
  'call("setns-mnt", 308, fd, CLONE_NEWNS)',
].join('\n');
const sh = [
  'unshare -U true 2>&1; echo unshare-U-rc=$?',
  'unshare -m true 2>&1; echo unshare-m-rc=$?',
  'unshare -n true 2>&1; echo unshare-n-rc=$?',
  'unshare -p -f true 2>&1; echo unshare-p-rc=$?',
  'unshare -r true 2>&1; echo unshare-r-rc=$?',
].join('; ');

describe.each(helperBuilds())('probe 13: nested namespaces ($name build)', (helper) => {
  it('every unshare, clone-with-flag and setns fails; clone3 answers ENOSYS', async () => {
    const a = await runIn(helper, request(['/usr/bin/sh', '-c', sh]));
    expect(a.termination, JSON.stringify(a)).toEqual({ cause: 'exit' });
    for (const k of ['unshare-U', 'unshare-m', 'unshare-n', 'unshare-p', 'unshare-r']) {
      expect(exitCodes(a.stdout)[k], `${k}: ${a.stdout}`).toBeGreaterThan(0);
    }
    const b = await runIn(helper, request(['/usr/bin/python3', '-c', py]));
    expect(b.termination, JSON.stringify(b)).toEqual({ cause: 'exit' });
    const c = syscallResults(b.stdout);
    for (const k of [
      'clone-newuser',
      'clone-newns',
      'clone-newpid',
      'clone-newnet',
      'unshare-user',
      'unshare-mnt',
      'setns-user',
      'setns-mnt',
    ]) {
      expect(c[k], `${k}: ${b.stdout}`).toEqual({ rc: -1, errno: 1 });
    }
    expect(c['clone3']).toEqual({ rc: -1, errno: 38 });
  });

  it.runIf(helper.name === 'debug-asan')(
    'control: without seccomp, dropped capabilities alone do not stop a nested user namespace',
    async () => {
      const r = await runWith(
        helper,
        request(['/usr/bin/sh', '-c', sh], { manifest: { require: [] } }),
        {
          governance: testGovernance({ requireAtLeast: [] }),
          ablate: ['seccomp'],
        },
      );
      expect(r.isolation.layers).toMatchObject({ caps_dropped: true, seccomp: false });
      expect(exitCodes(r.stdout)['unshare-U'], r.stdout).toBe(0);
      // Namespaces other than the user namespace do need a capability, which is gone.
      expect(exitCodes(r.stdout)['unshare-m']).toBeGreaterThan(0);
      expect(exitCodes(r.stdout)['unshare-n']).toBeGreaterThan(0);
    },
  );
});
