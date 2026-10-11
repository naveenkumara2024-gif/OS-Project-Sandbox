import { describe, expect, it } from 'vitest';
import { err, errFromException, errnoCode, ok, okVoid } from '../../src/util/result.js';

describe('Result', () => {
  it('wraps a value', () => {
    const r = ok(42);
    expect(r).toEqual({ ok: true, value: 42 });
  });

  it('wraps an error with code and context', () => {
    const r = err('ENOENT', 'read /nope');
    expect(r).toEqual({ ok: false, error: { code: 'ENOENT', context: 'read /nope' } });
  });

  it('exposes a shared void success', () => {
    expect(okVoid.ok).toBe(true);
  });

  it('extracts errno names from Node system errors', () => {
    const e = Object.assign(new Error('boom'), { code: 'EACCES' });
    expect(errnoCode(e)).toBe('EACCES');
  });

  it('falls back to EUNKNOWN for anything else', () => {
    expect(errnoCode(new Error('plain'))).toBe('EUNKNOWN');
    expect(errnoCode('string')).toBe('EUNKNOWN');
    expect(errnoCode(null)).toBe('EUNKNOWN');
    expect(errnoCode({ code: 'lowercase' })).toBe('EUNKNOWN');
    expect(errnoCode({ code: 7 })).toBe('EUNKNOWN');
  });

  it('builds a failure from a caught exception', () => {
    const e = Object.assign(new Error('boom'), { code: 'EPERM' });
    const r = errFromException(e, 'unshare');
    expect(r).toEqual({ ok: false, error: { code: 'EPERM', context: 'unshare' } });
  });
});
