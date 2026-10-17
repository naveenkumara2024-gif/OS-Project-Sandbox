import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { helperBuilds, request, runIn, runWith, testGovernance } from '../helpers/cell.js';
import { syscallResults } from '../helpers/parse.js';

// Probe 14 (CLAUDE.md 8.1): `bpf`, `perf_event_open`, `keyctl`, and io_uring. Layer expected to
// stop it: the seccomp filter. The control switches seccomp off in the debug build and shows that
// keyctl and io_uring (which an unprivileged process may use) then work, so the filter is what
// refuses them.

beforeEach(() => {
  vi.stubEnv('AEGIS_TEST_UNSAFE', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const py = [
  'import ctypes',
  'libc = ctypes.CDLL(None, use_errno=True)',
  'def call(label, *a):',
  '    ctypes.set_errno(0)',
  '    r = libc.syscall(*a)',
  '    print(label, r, ctypes.get_errno())',
  'attr = ctypes.create_string_buffer(128)',
  'call("bpf-prog-load", 321, 5, attr, 128)',
  'call("bpf-map-create", 321, 0, attr, 128)',
  'call("perf_event_open", 298, attr, 0, -1, -1, 0)',
  'call("keyctl-get-keyring-id", 250, 0, -3, 0, 0, 0)',
  'call("add_key", 248, b"user", b"probe", b"payload", 7, -3)',
  'call("io_uring_setup", 425, 8, attr)',
  'call("ptrace-traceme", 101, 0, 0, 0, 0)',
  'call("userfaultfd", 323, 0)',
  'call("process_vm_readv", 310, 1, 0, 0, 0, 0, 0)',
].join('\n');

describe.each(helperBuilds())('probe 14: kernel attack surface ($name build)', (helper) => {
  it('bpf, perf_event_open, keyctl and io_uring are all refused with EPERM', async () => {
    const r = await runIn(helper, request(['/usr/bin/python3', '-c', py]));
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    const c = syscallResults(r.stdout);
    for (const k of [
      'bpf-prog-load',
      'bpf-map-create',
      'perf_event_open',
      'keyctl-get-keyring-id',
      'add_key',
      'io_uring_setup',
      'ptrace-traceme',
      'userfaultfd',
      'process_vm_readv',
    ]) {
      expect(c[k], `${k}: ${r.stdout}`).toEqual({ rc: -1, errno: 1 });
    }
  });

  it.runIf(helper.name === 'debug-asan')(
    'control: without seccomp the keyring and io_uring calls work, so the filter is what refuses them',
    async () => {
      const r = await runWith(
        helper,
        request(['/usr/bin/python3', '-c', py], { manifest: { require: [] } }),
        { governance: testGovernance({ requireAtLeast: [] }), ablate: ['seccomp'] },
      );
      expect(r.isolation.layers).toMatchObject({ caps_dropped: true, seccomp: false });
      const c = syscallResults(r.stdout);
      expect(c['keyctl-get-keyring-id']?.rc, r.stdout).toBeGreaterThan(0);
      // io_uring may be disabled by the host's sysctl; if so it answers EPERM/ENOSYS by itself.
      // Either way the control proves keyctl, which has no such switch.
      // bpf and perf_event_open still fail here, now because capabilities are gone.
      expect(c['bpf-prog-load']?.rc).toBe(-1);
    },
  );
});
