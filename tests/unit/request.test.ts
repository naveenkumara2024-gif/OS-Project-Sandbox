import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_REQUEST_BYTES, parseRunRequest } from '../../src/gateway/request.js';

const ok = { id: 'r1', command: ['/usr/bin/echo', 'hi'] };

describe('parseRunRequest', () => {
  it('accepts a minimal request and applies the default limits', () => {
    const r = parseRunRequest(JSON.stringify(ok));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe('r1');
    expect(r.value.command).toEqual(['/usr/bin/echo', 'hi']);
    expect(r.value.wallMs).toBe(10_000);
    expect(r.value.outputBytes).toBe(256 * 1024);
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
    expect(r.value.wallMs).toBe(500);
    expect(r.value.outputBytes).toBe(4096);
  });

  it.each([
    ['unknown top-level field', { ...ok, extra: 1 }],
    ['unknown limit field', { ...ok, limits: { wall_ms: 5, nope: 1 } }],
    ['relative command[0]', { ...ok, command: ['echo'] }],
    ['empty command', { ...ok, command: [] }],
    ['NUL in an argument', { ...ok, command: ['/usr/bin/echo', 'a\u0000b'] }],
    ['bad id', { ...ok, id: '../x' }],
    ['wall_ms over the maximum', { ...ok, limits: { wall_ms: 60_001 } }],
    ['wall_ms zero', { ...ok, limits: { wall_ms: 0 } }],
    ['output_kb over the maximum', { ...ok, limits: { output_kb: 1025 } }],
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

  it('never throws on arbitrary JSON values and never exceeds the bounds when it accepts', () => {
    fc.assert(
      fc.property(fc.json(), (j) => {
        const r = parseRunRequest(j);
        if (r.ok) {
          expect(r.value.wallMs).toBeLessThanOrEqual(60_000);
          expect(r.value.outputBytes).toBeLessThanOrEqual(1024 * 1024);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('keeps accepted values within bounds for arbitrary numeric limits', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (w, o) => {
        const r = parseRunRequest(JSON.stringify({ ...ok, limits: { wall_ms: w, output_kb: o } }));
        if (r.ok) {
          expect(r.value.wallMs).toBeGreaterThanOrEqual(1);
          expect(r.value.wallMs).toBeLessThanOrEqual(60_000);
          expect(r.value.outputBytes).toBeLessThanOrEqual(1024 * 1024);
        }
      }),
      { numRuns: 300 },
    );
  });
});
