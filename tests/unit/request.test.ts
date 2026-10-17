import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_REQUEST_BYTES, parseRunRequest } from '../../src/gateway/request.js';

const ok = { id: 'r1', command: ['/usr/bin/echo', 'hi'] };

describe('parseRunRequest', () => {
  it('accepts a minimal request and asks for nothing (defaults apply at resolution)', () => {
    const r = parseRunRequest(JSON.stringify(ok));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe('r1');
    expect(r.value.command).toEqual(['/usr/bin/echo', 'hi']);
    expect(r.value.manifest).toEqual({
      limits: {},
      networkMode: 'none',
      networkAllow: [],
      require: null,
    });
    expect(r.value.env.size).toBe(0);
  });

  it('accepts explicit limits and env, returning env as a Map', () => {
    const r = parseRunRequest(
      JSON.stringify({ ...ok, env: { FOO: 'bar' }, limits: { wall_ms: 500, output_kb: 4 } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.env).toBeInstanceOf(Map);
    expect(r.value.env.get('FOO')).toBe('bar');
    expect(r.value.manifest.limits).toEqual({ wall_ms: 500, output_kb: 4 });
  });

  it('treats a top-level limits object as manifest.limits', () => {
    const legacy = parseRunRequest(JSON.stringify({ ...ok, limits: { wall_ms: 500 } }));
    const modern = parseRunRequest(
      JSON.stringify({ ...ok, manifest: { limits: { wall_ms: 500 } } }),
    );
    expect(legacy.ok && modern.ok).toBe(true);
    if (legacy.ok && modern.ok) expect(legacy.value.manifest).toEqual(modern.value.manifest);
  });

  it('refuses an ambiguous request that has both limits and manifest', () => {
    const r = parseRunRequest(
      JSON.stringify({ ...ok, limits: { wall_ms: 5 }, manifest: { limits: { wall_ms: 5 } } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('EINVAL');
  });

  it('keeps the manifest request, lower-casing and listing domains', () => {
    const r = parseRunRequest(
      JSON.stringify({
        ...ok,
        manifest: {
          network: { mode: 'none', allow: ['Example.COM'] },
          workspace: { mode: 'overlay' },
          require: ['landlock'],
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.manifest.networkAllow).toEqual(['example.com']);
      expect(r.value.manifest.require).toEqual(['landlock']);
    }
  });

  it.each([
    ['unknown top-level field', { ...ok, extra: 1 }],
    ['unknown limit field', { ...ok, limits: { wall_ms: 5, nope: 1 } }],
    ['relative command[0]', { ...ok, command: ['echo'] }],
    ['empty command', { ...ok, command: [] }],
    ['NUL in an argument', { ...ok, command: ['/usr/bin/echo', 'a\u0000b'] }],
    ['bad id', { ...ok, id: '../x' }],
    ['wall_ms zero', { ...ok, limits: { wall_ms: 0 } }],
    ['wall_ms beyond any sane value', { ...ok, limits: { wall_ms: 1e13 } }],
    ['fractional limit', { ...ok, limits: { wall_ms: 1.5 } }],
    ['unknown manifest key', { ...ok, manifest: { extra: 1 } }],
    ['unknown manifest limit', { ...ok, manifest: { limits: { cores: 4 } } }],
    [
      'network mode other than none or brokered',
      { ...ok, manifest: { network: { mode: 'allowlist' } } },
    ],
    ['bad domain', { ...ok, manifest: { network: { allow: ['not a host'] } } }],
    ['domain with a path', { ...ok, manifest: { network: { allow: ['a.example/x'] } } }],
    ['unknown layer in require', { ...ok, manifest: { require: ['telepathy'] } }],
    ['workspace mode other than overlay', { ...ok, manifest: { workspace: { mode: 'rw' } } }],
    ['env PATH', { ...ok, env: { PATH: '/x' } }],
    ['env LD_PRELOAD', { ...ok, env: { LD_PRELOAD: '/x' } }],
    ['lower-case env name', { ...ok, env: { foo: 'x' } }],
    ['non-string env value', { ...ok, env: { FOO: 1 } }],
  ])('rejects %s', (_name, body) => {
    expect(parseRunRequest(JSON.stringify(body)).ok).toBe(false);
  });

  it('rejects prototype-polluting keys wherever they appear', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const text = `{"id":"r1","command":["/usr/bin/true"],"env":{"${key}":"x"}}`;
      expect(parseRunRequest(text).ok, key).toBe(false);
    }
    expect(parseRunRequest('{"__proto__":{"polluted":1},"id":"r","command":["/a"]}').ok).toBe(
      false,
    );
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects too many env entries and oversize env', () => {
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`V${String(i)}`, 'x']));
    expect(parseRunRequest(JSON.stringify({ ...ok, env: many })).ok).toBe(false);
    const big = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`V${String(i)}`, 'x'.repeat(3000)]),
    );
    expect(parseRunRequest(JSON.stringify({ ...ok, env: big })).ok).toBe(false);
  });

  it('rejects an oversize body before parsing it', () => {
    const r = parseRunRequest(
      `{"id":"r","command":["/a"],"pad":"${'x'.repeat(MAX_REQUEST_BYTES)}"}`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E2BIG');
  });

  it('rejects invalid JSON without echoing it', () => {
    const r = parseRunRequest('{"id": SECRET-PAYLOAD');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.context).not.toContain('SECRET');
  });

  it('never throws on arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (s) => {
        const r = parseRunRequest(s);
        expect(typeof r.ok).toBe('boolean');
      }),
      { numRuns: 300 },
    );
  });

  it('never throws on arbitrary JSON values', () => {
    fc.assert(
      fc.property(fc.json(), (j) => {
        expect(typeof parseRunRequest(j).ok).toBe('boolean');
      }),
      { numRuns: 300 },
    );
  });

  it('keeps accepted limits positive and below the sanity bound (the ceiling clamps the rest)', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (w, o) => {
        const r = parseRunRequest(JSON.stringify({ ...ok, limits: { wall_ms: w, output_kb: o } }));
        if (r.ok) {
          for (const v of Object.values(r.value.manifest.limits)) {
            expect(v).toBeGreaterThanOrEqual(1);
            expect(v).toBeLessThanOrEqual(1_000_000_000_000);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
