import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_POLICY_BYTES, parsePolicyFile } from '../../src/policy/ceiling.js';
import { loadPolicy } from '../../src/policy/policy.js';

const good = {
  ingest_roots: ['/srv/project'],
  ingest_excludes: ['.ssh'],
  ceiling: {
    limits: {
      wall_ms: 60000,
      output_kb: 1024,
      memory_mb: 2048,
      pids: 512,
      cpu_percent: 400,
      cpu_ms: 300000,
      disk_mb: 256,
    },
    network_allow: ['PyPI.org', 'pypi.org'],
    require_at_least: ['seccomp', 'caps_dropped', 'seccomp'],
  },
};
const parse = (v: unknown) => parsePolicyFile(Buffer.from(JSON.stringify(v)));

describe('parsePolicyFile', () => {
  it('accepts a complete policy, lower-casing and de-duplicating its lists', () => {
    const r = parse(good);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ceiling.networkAllow).toEqual(['pypi.org']);
    expect(r.value.ceiling.requireAtLeast).toEqual(['caps_dropped', 'seccomp']);
    expect(r.value.ceiling.limits.memory_mb).toBe(2048);
    // commit_roots defaults to ingest_roots, as in Stage 3.
    expect(r.value.commitRoots).toEqual(['/srv/project']);
  });

  it('accepts a _comment string', () => {
    expect(parse({ ...good, _comment: 'owned by the human' }).ok).toBe(true);
  });

  it.each([
    ['an unknown top-level key', { ...good, extra: 1 }],
    ['an unknown ceiling key', { ...good, ceiling: { ...good.ceiling, extra: 1 } }],
    [
      'an unknown limit',
      { ...good, ceiling: { ...good.ceiling, limits: { ...good.ceiling.limits, cores: 1 } } },
    ],
    ['a missing ceiling', { ingest_roots: [] }],
    ['a missing limit', { ...good, ceiling: { ...good.ceiling, limits: { wall_ms: 1 } } }],
    [
      'a zero limit',
      { ...good, ceiling: { ...good.ceiling, limits: { ...good.ceiling.limits, pids: 0 } } },
    ],
    [
      'a limit past the sanity bound',
      { ...good, ceiling: { ...good.ceiling, limits: { ...good.ceiling.limits, disk_mb: 4096 } } },
    ],
    [
      'a bad hostname',
      { ...good, ceiling: { ...good.ceiling, network_allow: ['no spaces.example'] } },
    ],
    [
      'an unknown required layer',
      { ...good, ceiling: { ...good.ceiling, require_at_least: ['telepathy'] } },
    ],
    ['a non-string root', { ...good, ingest_roots: [1] }],
  ])('rejects %s', (_name, value) => {
    expect(parse(value).ok).toBe(false);
  });

  it('rejects dangerous keys wherever they appear', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const text = JSON.stringify(good).replace(
        '"ingest_excludes"',
        `"${key}":1,"ingest_excludes"`,
      );
      expect(parsePolicyFile(Buffer.from(text)).ok, key).toBe(false);
    }
  });

  it('rejects invalid JSON and an oversize file without reading it as a policy', () => {
    expect(parsePolicyFile(Buffer.from('{not json')).ok).toBe(false);
    const big = parsePolicyFile(Buffer.alloc(MAX_POLICY_BYTES + 1, 0x20));
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error.code).toBe('E2BIG');
  });

  it('never throws on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (b) => {
        expect(typeof parsePolicyFile(b).ok).toBe('boolean');
      }),
      { numRuns: 300 },
    );
  });
});

describe('loadPolicy', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-policy-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('hashes the bytes exactly as read', () => {
    const p = join(dir, 'policy.json');
    writeFileSync(p, JSON.stringify(good));
    const a = loadPolicy(p);
    writeFileSync(p, JSON.stringify(good, null, 2));
    const b = loadPolicy(p);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value.ceilingSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.value.ceilingSha256).not.toBe(b.value.ceilingSha256);
    }
  });

  it('refuses a missing file instead of falling back to defaults', () => {
    const r = loadPolicy(join(dir, 'nope.json'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ENOENT');
  });

  it('refuses a file with an unknown key', () => {
    const p = join(dir, 'policy.json');
    writeFileSync(p, JSON.stringify({ ...good, surprise: true }));
    const r = loadPolicy(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('EINVAL');
  });

  it('refuses an oversize file', () => {
    const p = join(dir, 'policy.json');
    writeFileSync(p, ' '.repeat(MAX_POLICY_BYTES + 1));
    const r = loadPolicy(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E2BIG');
  });

  it('accepts the repository policy.default.json', () => {
    const r = loadPolicy(join(import.meta.dirname, '..', '..', 'policy.default.json'));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});
