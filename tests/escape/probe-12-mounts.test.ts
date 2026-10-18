import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { helperBuilds, request, runIn, runWith, testGovernance } from '../helpers/cell.js';
import { exitCodes } from '../helpers/parse.js';

// Probe 12 (CLAUDE.md 8.1): `mount` calls, `mknod /dev/sda`, `chroot`. Layers expected to stop it:
// the capability drop and the seccomp filter, each sufficient on its own. The debug build can
// switch layers off (test-only, CLAUDE.md 6.5) to show which layer does the work. Measured: Landlock
// also refuses mount operations by itself (the kernel denies mount, umount and pivot_root to any
// process under a Landlock domain), so it is a third sufficient layer for mounts, though not for
// chroot. With all three off the mount succeeds in the cell's own mount namespace, which proves the
// probe is real.

beforeEach(() => {
  vi.stubEnv('AEGIS_TEST_UNSAFE', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const script = [
  'mount -t tmpfs none /tmp 2>&1; echo mount-rc=$?',
  'mount --bind /usr /tmp 2>&1; echo bind-rc=$?',
  'mknod /dev/sda b 8 0 2>&1; echo mknod-rc=$?',
  'mknod /tmp/sda b 8 0 2>&1; echo mknod-tmp-rc=$?',
  'chroot /tmp /usr/bin/true 2>&1; echo chroot-rc=$?',
  'test -e /dev/sda && echo SDA-EXISTS || echo no-sda',
].join('; ');

const noRequirements = { governance: testGovernance({ requireAtLeast: [] }) };
const req = () => request(['/usr/bin/sh', '-c', script], { manifest: { require: [] } });

describe.each(helperBuilds())('probe 12: mounts and device nodes ($name build)', (helper) => {
  it('every attempt fails under the full stack', async () => {
    const r = await runIn(helper, request(['/usr/bin/sh', '-c', script]));
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    const c = exitCodes(r.stdout);
    for (const k of ['mount', 'bind', 'mknod', 'mknod-tmp', 'chroot']) {
      expect(c[k], `${k}: ${r.stdout}`).toBeGreaterThan(0);
    }
    expect(r.stdout).toMatch(/not permitted|permission denied/i);
    expect(r.stdout).toContain('no-sda');
  });

  it.runIf(helper.name === 'debug-asan')(
    'the capability drop alone stops mount and chroot',
    async () => {
      const r = await runWith(helper, req(), {
        ...noRequirements,
        ablate: ['seccomp', 'landlock'],
      });
      expect(r.isolation.layers).toMatchObject({ caps_dropped: true, seccomp: false });
      const c = exitCodes(r.stdout);
      expect(c['mount']).toBeGreaterThan(0);
      expect(c['bind']).toBeGreaterThan(0);
      expect(c['chroot']).toBeGreaterThan(0);
      expect(r.stdout).toContain('no-sda');
    },
  );

  it.runIf(helper.name === 'debug-asan')(
    'the seccomp filter alone stops mount and chroot',
    async () => {
      const r = await runWith(helper, req(), {
        ...noRequirements,
        ablate: ['caps_dropped', 'landlock'],
      });
      expect(r.isolation.layers).toMatchObject({ caps_dropped: false, seccomp: true });
      const c = exitCodes(r.stdout);
      expect(c['mount']).toBeGreaterThan(0);
      expect(c['bind']).toBeGreaterThan(0);
      expect(c['chroot']).toBeGreaterThan(0);
    },
  );

  it.runIf(helper.name === 'debug-asan')(
    'Landlock alone also refuses the mount calls (the kernel denies them under a domain)',
    async () => {
      const r = await runWith(helper, req(), {
        ...noRequirements,
        ablate: ['caps_dropped', 'seccomp'],
      });
      expect(r.isolation.layers).toMatchObject({
        caps_dropped: false,
        seccomp: false,
        landlock: true,
      });
      expect(exitCodes(r.stdout)['mount']).toBeGreaterThan(0);
      expect(exitCodes(r.stdout)['bind']).toBeGreaterThan(0);
    },
  );

  it.runIf(helper.name === 'debug-asan')(
    'control: with all three off the mount works inside the cell’s own mount namespace',
    async () => {
      const r = await runWith(helper, req(), {
        ...noRequirements,
        ablate: ['caps_dropped', 'seccomp', 'landlock'],
      });
      expect(r.isolation.layers).toMatchObject({
        caps_dropped: false,
        seccomp: false,
        landlock: false,
      });
      // The probe is real: it succeeds without the layers. Nothing reaches the host, because the
      // mount namespace is the cell's own. mknod of a block device fails even here: a user
      // namespace can never create one (that is the kernel, not an Aegis layer).
      expect(exitCodes(r.stdout)['mount']).toBe(0);
      expect(exitCodes(r.stdout)['mknod']).toBeGreaterThan(0);
    },
  );
});
