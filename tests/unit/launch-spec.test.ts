import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decodeLaunchSpec,
  encodeLaunchSpec,
  isCleanAbsolutePath,
  REQUIRE_BITS,
  REQUIRE_MASK_ALL,
  SPEC_MAX_BYTES,
  SPEC_MAX_ENTRIES,
  type LaunchSpec,
  type RootEntry,
} from '../../src/sys/launch-spec.js';

const base: LaunchSpec = {
  argv: ['/usr/bin/echo', 'hi'],
  env: ['PATH=/usr/bin:/bin', 'A=b'],
  rootMountpoint: '/tmp/aegis-cell-x/root',
  hostname: 'aegis',
  rootTmpfsBytes: 64 * 1024 * 1024,
  tmpTmpfsBytes: 16 * 1024 * 1024,
  entries: [
    { kind: 'mkdir', src: '', tgt: '/usr' },
    { kind: 'bind-dir', src: '/usr/bin', tgt: '/usr/bin' },
    { kind: 'bind-file', src: '/usr/lib/os-release', tgt: '/usr/lib/os-release' },
    { kind: 'symlink', src: '../lib/x', tgt: '/usr/lib/y' },
  ],
  maskFiles: ['/usr/bin/node'],
  maskDirs: ['/usr/include/node'],
  cgroupFd: true,
};

function encode(spec: LaunchSpec): Uint8Array {
  const r = encodeLaunchSpec(spec);
  if (!r.ok) throw new Error(r.error.context);
  return r.value;
}

describe('launch spec encoder', () => {
  it('round-trips through the reference decoder', () => {
    const d = decodeLaunchSpec(encode(base));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.value).toEqual(base);
  });

  it('starts with the magic, version and exact total length', () => {
    const b = Buffer.from(encode(base));
    expect(b.toString('latin1', 0, 4)).toBe('AEGS');
    expect(b.readUInt16LE(4)).toBe(1);
    expect(b.readUInt32LE(8)).toBe(b.length);
  });

  it.each([
    ['relative argv[0]', { ...base, argv: ['echo'] }],
    ['no argv', { ...base, argv: [] }],
    ['NUL in argv', { ...base, argv: ['/usr/bin/echo', 'a\u0000'] }],
    ['argument of 4096 bytes', { ...base, argv: ['/usr/bin/echo', 'x'.repeat(4096)] }],
    ['env without =', { ...base, env: ['NOEQUALS'] }],
    ['env starting with =', { ...base, env: ['=x'] }],
    ['tmpfs too small', { ...base, rootTmpfsBytes: 1000 }],
    ['tmpfs too large', { ...base, tmpTmpfsBytes: 2 ** 31 }],
    ['relative mountpoint', { ...base, rootMountpoint: 'tmp/x' }],
    ['dot-dot in mountpoint', { ...base, rootMountpoint: '/tmp/../x' }],
    ['hostname with slash', { ...base, hostname: 'a/b' }],
    [
      'bind source not absolute',
      { ...base, entries: [{ kind: 'bind-dir', src: 'usr', tgt: '/usr' }] },
    ],
    ['target with ..', { ...base, entries: [{ kind: 'mkdir', src: '', tgt: '/usr/../etc' }] }],
    ['mkdir with a source', { ...base, entries: [{ kind: 'mkdir', src: '/x', tgt: '/usr' }] }],
    ['empty symlink text', { ...base, entries: [{ kind: 'symlink', src: '', tgt: '/usr/x' }] }],
    ['relative mask', { ...base, maskFiles: ['usr/bin/node'] }],
    ['mask outside /usr', { ...base, maskFiles: ['/etc/passwd'] }],
    [
      'bind source outside /usr',
      { ...base, entries: [{ kind: 'bind-dir', src: '/etc', tgt: '/usr/etc' }] },
    ],
    [
      'bind source that only looks like /usr',
      { ...base, entries: [{ kind: 'bind-dir', src: '/usrx/bin', tgt: '/usr/bin' }] },
    ],
    ['target outside /usr', { ...base, entries: [{ kind: 'mkdir', src: '', tgt: '/etc' }] }],
  ] as [string, LaunchSpec][])('rejects %s', (_name, spec) => {
    expect(encodeLaunchSpec(spec).ok).toBe(false);
  });

  it('rejects more entries than the cap', () => {
    const entries: RootEntry[] = Array.from({ length: SPEC_MAX_ENTRIES + 1 }, (_, i) => ({
      kind: 'mkdir',
      src: '',
      tgt: `/usr/d${String(i)}`,
    }));
    const r = encodeLaunchSpec({ ...base, entries });
    expect(r.ok).toBe(false);
  });

  it('refuses to exceed the byte cap', () => {
    const long = '/usr/' + 'a'.repeat(4000);
    const entries: RootEntry[] = Array.from({ length: 40 }, (_, i) => ({
      kind: 'bind-dir',
      src: `${long}${String(i)}`,
      tgt: `${long}${String(i)}`,
    }));
    const r = encodeLaunchSpec({ ...base, entries });
    expect(r.ok).toBe(false);
  });

  it('treats paths strictly', () => {
    expect(isCleanAbsolutePath('/usr/bin')).toBe(true);
    for (const p of ['/', '', 'usr', '/usr/', '//usr', '/usr//bin', '/usr/./bin', '/usr/../bin']) {
      expect(isCleanAbsolutePath(p), p).toBe(false);
    }
  });

  it('round-trips arbitrary valid specs and always stays under the cap', () => {
    const seg = fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/);
    const path = fc.array(seg, { minLength: 1, maxLength: 4 }).map((p) => `/usr/${p.join('/')}`);
    const entry: fc.Arbitrary<RootEntry> = fc.oneof(
      path.map((p): RootEntry => ({ kind: 'bind-dir', src: p, tgt: p })),
      path.map((p): RootEntry => ({ kind: 'bind-file', src: p, tgt: p })),
      path.map((p): RootEntry => ({ kind: 'mkdir', src: '', tgt: p })),
      fc.tuple(seg, path).map(([l, p]): RootEntry => ({ kind: 'symlink', src: l, tgt: p })),
    );
    fc.assert(
      fc.property(
        fc.array(entry, { maxLength: 100 }),
        fc.array(fc.stringMatching(/^[A-Za-z0-9 ._-]{0,40}$/), { minLength: 1, maxLength: 8 }),
        (entries, args) => {
          const spec: LaunchSpec = { ...base, argv: ['/usr/bin/x', ...args], entries };
          const e = encodeLaunchSpec(spec);
          expect(e.ok).toBe(true);
          if (!e.ok) return;
          expect(e.value.length).toBeLessThanOrEqual(SPEC_MAX_BYTES);
          const d = decodeLaunchSpec(e.value);
          expect(d.ok && d.value).toEqual(spec);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('the decoder never throws on arbitrary or mutated bytes', () => {
    const good = encode(base);
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 300 }),
        fc.nat(good.length - 1),
        fc.nat(255),
        (junk, i, v) => {
          expect(typeof decodeLaunchSpec(junk).ok).toBe('boolean');
          const mutated = Uint8Array.from(good);
          mutated[i] = v;
          expect(typeof decodeLaunchSpec(mutated).ok).toBe('boolean');
          expect(typeof decodeLaunchSpec(good.subarray(0, i)).ok).toBe('boolean');
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('launch spec require mask (Stage 4)', () => {
  it('round-trips the mask and the test-only flag', () => {
    const mask = REQUIRE_BITS.caps_dropped | REQUIRE_BITS.seccomp | REQUIRE_BITS.landlock;
    const d = decodeLaunchSpec(
      encode({ ...base, requireMask: mask, ablateMask: REQUIRE_BITS.landlock }),
    );
    expect(d.ok && d.value.requireMask).toBe(mask);
    expect(d.ok && d.value.ablateMask).toBe(REQUIRE_BITS.landlock);
  });

  it('leaves the mask out when none is given, so the helper assumes the default, not nothing', () => {
    const d = decodeLaunchSpec(encode(base));
    expect(d.ok && d.value.requireMask).toBeUndefined();
  });

  it('allows an explicit empty mask', () => {
    const d = decodeLaunchSpec(encode({ ...base, requireMask: 0 }));
    expect(d.ok && d.value.requireMask).toBe(0);
  });

  it.each([-1, 1.5, REQUIRE_MASK_ALL + 1, 2 ** 32])('refuses the mask %s', (m) => {
    expect(encodeLaunchSpec({ ...base, requireMask: m }).ok).toBe(false);
  });

  it.each([0, -1, 1.5, REQUIRE_BITS.overlay, REQUIRE_MASK_ALL + 1])(
    'refuses the ablate mask %s',
    (m) => {
      expect(encodeLaunchSpec({ ...base, ablateMask: m }).ok).toBe(false);
    },
  );

  it('uses bits that match native/src/spec.h', () => {
    expect(REQUIRE_BITS).toEqual({
      caps_dropped: 1,
      no_new_privs: 2,
      seccomp: 4,
      landlock: 8,
      overlay: 16,
    });
    expect(REQUIRE_MASK_ALL).toBe(31);
  });
});
