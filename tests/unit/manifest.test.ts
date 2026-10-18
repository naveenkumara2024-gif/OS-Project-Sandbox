import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, type CanonicalValue } from '../../src/policy/canonical.js';
import type { Ceiling } from '../../src/policy/ceiling.js';
import { DEFAULT_LIMITS, LIMIT_NAMES, type Limits } from '../../src/policy/limits.js';
import {
  DEFAULT_REQUIRE,
  EMPTY_MANIFEST_REQUEST,
  manifestSha256,
  resolveManifest,
  type ManifestRequest,
} from '../../src/policy/manifest.js';
import { RECEIPT_LAYERS } from '../../src/probe/isolation.js';

const ceilingLimits: Limits = {
  wall_ms: 60_000,
  output_kb: 1024,
  memory_mb: 2048,
  pids: 512,
  cpu_percent: 400,
  cpu_ms: 300_000,
  disk_mb: 256,
};
const ceiling: Ceiling = {
  limits: ceilingLimits,
  networkAllow: ['pypi.org'],
  networkPorts: [443],
  maxCells: 4,
  memoryBudgetMb: 4096,
  maxSessions: 8,
  sessionIdleS: 1800,
  requireAtLeast: ['caps_dropped', 'no_new_privs', 'seccomp'],
};

const requestWith = (over: Partial<ManifestRequest>): ManifestRequest => ({
  ...EMPTY_MANIFEST_REQUEST,
  ...over,
});

describe('resolveManifest', () => {
  it('gives an empty request the defaults and the default requirements, with nothing clamped', () => {
    const r = resolveManifest(EMPTY_MANIFEST_REQUEST, ceiling);
    expect(r.manifest.limits).toEqual(DEFAULT_LIMITS);
    expect(r.manifest.require).toEqual([...DEFAULT_REQUIRE].sort());
    expect(r.manifest.network).toEqual({ mode: 'none', allow: [] });
    expect(r.clamped).toEqual([]);
  });

  it('clamps a request above the ceiling and reports what was asked and what was granted', () => {
    const r = resolveManifest(requestWith({ limits: { memory_mb: 8192, pids: 100 } }), ceiling);
    expect(r.manifest.limits.memory_mb).toBe(2048);
    expect(r.manifest.limits.pids).toBe(100);
    expect(r.clamped).toEqual([{ field: 'limits.memory_mb', requested: 8192, granted: 2048 }]);
  });

  it('removes a domain that the ceiling does not list, and keeps one it does', () => {
    const r = resolveManifest(
      requestWith({ networkAllow: ['evil.example', 'pypi.org', 'evil.example'] }),
      ceiling,
    );
    expect(r.manifest.network).toEqual({ mode: 'none', allow: ['pypi.org'] });
    expect(r.clamped).toEqual([
      { field: 'network.allow', requested: 'evil.example', granted: null },
    ]);
  });

  it('keeps a brokered request that still has an allowed host', () => {
    const r = resolveManifest(
      requestWith({ networkMode: 'brokered', networkAllow: ['pypi.org', 'evil.example'] }),
      ceiling,
    );
    expect(r.manifest.network).toEqual({ mode: 'brokered', allow: ['pypi.org'] });
    expect(r.clamped).toEqual([
      { field: 'network.allow', requested: 'evil.example', granted: null },
    ]);
  });

  it('turns a brokered request with nothing left on its allowlist into an air-gapped one', () => {
    const r = resolveManifest(
      requestWith({ networkMode: 'brokered', networkAllow: ['evil.example'] }),
      ceiling,
    );
    expect(r.manifest.network).toEqual({ mode: 'none', allow: [] });
    expect(r.clamped).toContainEqual({
      field: 'network.mode',
      requested: 'brokered',
      granted: 'none',
    });
    const bare = resolveManifest(requestWith({ networkMode: 'brokered' }), ceiling);
    expect(bare.manifest.network.mode).toBe('none');
  });

  it('hashes the network mode, and leaves the hash of an air-gapped manifest unchanged', () => {
    const a = resolveManifest(requestWith({ networkAllow: ['pypi.org'] }), ceiling);
    const b = resolveManifest(
      requestWith({ networkMode: 'brokered', networkAllow: ['pypi.org'] }),
      ceiling,
    );
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('adds the ceiling requirements to a request that lists others, never removing them', () => {
    const r = resolveManifest(requestWith({ require: ['landlock'] }), ceiling);
    expect(r.manifest.require).toEqual(['caps_dropped', 'landlock', 'no_new_privs', 'seccomp']);
    const none = resolveManifest(requestWith({ require: [] }), ceiling);
    expect(none.manifest.require).toEqual(['caps_dropped', 'no_new_privs', 'seccomp']);
  });

  it('lets a tight ceiling clamp the defaults too', () => {
    const tight: Ceiling = { ...ceiling, limits: { ...ceilingLimits, disk_mb: 8 } };
    const r = resolveManifest(EMPTY_MANIFEST_REQUEST, tight);
    expect(r.manifest.limits.disk_mb).toBe(8);
    expect(r.clamped).toEqual([
      { field: 'limits.disk_mb', requested: DEFAULT_LIMITS.disk_mb, granted: 8 },
    ]);
  });

  it('hashes identically for the same manifest and differently when any value changes', () => {
    const a = resolveManifest(requestWith({ limits: { wall_ms: 500 } }), ceiling);
    const b = resolveManifest(requestWith({ limits: { wall_ms: 500 } }), ceiling);
    const c = resolveManifest(requestWith({ limits: { wall_ms: 501 } }), ceiling);
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).not.toBe(c.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on the order of a request set', () => {
    const a = resolveManifest(requestWith({ require: ['landlock', 'overlay'] }), ceiling);
    const b = resolveManifest(requestWith({ require: ['overlay', 'landlock'] }), ceiling);
    expect(a.sha256).toBe(b.sha256);
  });
});

const arbLimit = fc.integer({ min: 1, max: 1_000_000_000_000 });
const arbRequest: fc.Arbitrary<ManifestRequest> = fc.record({
  networkMode: fc.constantFrom('none' as const, 'brokered' as const),
  limits: fc.record(
    {
      wall_ms: arbLimit,
      output_kb: arbLimit,
      memory_mb: arbLimit,
      pids: arbLimit,
      cpu_percent: arbLimit,
      cpu_ms: arbLimit,
      disk_mb: arbLimit,
    },
    { requiredKeys: [] },
  ),
  networkAllow: fc.array(fc.constantFrom('pypi.org', 'evil.example', 'a.b.c', 'x.test')),
  require: fc.option(fc.subarray([...RECEIPT_LAYERS]), { nil: null }),
});

describe('resolveManifest properties', () => {
  it('never exceeds the ceiling, whatever is asked', () => {
    fc.assert(
      fc.property(arbRequest, (req) => {
        const m = resolveManifest(req, ceiling).manifest;
        for (const name of LIMIT_NAMES) {
          expect(m.limits[name]).toBeLessThanOrEqual(ceilingLimits[name]);
          expect(m.limits[name]).toBeGreaterThanOrEqual(1);
        }
        for (const d of m.network.allow) expect(ceiling.networkAllow).toContain(d);
      }),
      { numRuns: 500 },
    );
  });

  it('always contains the ceiling requirements and only known layers, sorted and unique', () => {
    fc.assert(
      fc.property(arbRequest, (req) => {
        const m = resolveManifest(req, ceiling).manifest;
        for (const l of ceiling.requireAtLeast) expect(m.require).toContain(l);
        expect([...m.require]).toEqual([...new Set(m.require)].sort());
        for (const l of m.require) expect(RECEIPT_LAYERS).toContain(l);
      }),
      { numRuns: 500 },
    );
  });

  it('is idempotent: resolving what it resolved changes nothing', () => {
    fc.assert(
      fc.property(arbRequest, (req) => {
        const first = resolveManifest(req, ceiling);
        const again = resolveManifest(
          {
            limits: first.manifest.limits,
            networkMode: first.manifest.network.mode,
            networkAllow: first.manifest.network.allow,
            require: first.manifest.require,
          },
          ceiling,
        );
        expect(again.sha256).toBe(first.sha256);
        expect(again.clamped).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('changes the hash when any limit changes', () => {
    fc.assert(
      fc.property(fc.constantFrom(...LIMIT_NAMES), (name) => {
        const base = resolveManifest(EMPTY_MANIFEST_REQUEST, ceiling).manifest;
        const bumped = { ...base, limits: { ...base.limits, [name]: base.limits[name] + 1 } };
        expect(manifestSha256(bumped)).not.toBe(manifestSha256(base));
      }),
    );
  });
});

describe('canonicalJson', () => {
  it('sorts keys, drops whitespace and keeps array order', () => {
    const r = canonicalJson({ b: [3, 1], a: { z: 'x', y: true }, c: null });
    expect(r.ok && r.value).toBe('{"a":{"y":true,"z":"x"},"b":[3,1],"c":null}');
  });

  it('refuses floats, NaN and unsafe integers', () => {
    for (const v of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(canonicalJson(v).ok, String(v)).toBe(false);
    }
  });

  it('does not depend on the order keys were inserted in', () => {
    const arbJson: fc.Arbitrary<CanonicalValue> = fc.letrec<{ v: CanonicalValue }>((tie) => ({
      v: fc.oneof(
        { maxDepth: 3 },
        fc.string({ maxLength: 8 }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.boolean(),
        fc.constant(null),
        fc.array(tie('v'), { maxLength: 3 }),
        fc.dictionary(fc.string({ maxLength: 6 }), tie('v'), { maxKeys: 4 }),
      ),
    })).v;
    const reversed = (v: CanonicalValue): CanonicalValue => {
      if (Array.isArray(v)) return (v as CanonicalValue[]).map(reversed);
      if (typeof v === 'object' && v !== null) {
        const o = v as { [k: string]: CanonicalValue };
        return Object.fromEntries(
          Object.keys(o)
            .reverse()
            .map((k) => [k, reversed(o[k] as CanonicalValue)]),
        );
      }
      return v;
    };
    fc.assert(
      fc.property(arbJson, (v) => {
        expect(canonicalJson(reversed(v))).toEqual(canonicalJson(v));
      }),
      { numRuns: 300 },
    );
  });
});
