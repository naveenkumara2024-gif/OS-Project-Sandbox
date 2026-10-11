import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  isCleanRelativePath,
  isUnderAnyRoot,
  resolveIngestSource,
  validateInlineFiles,
  type IngestEnv,
  type IngestPolicy,
} from '../../src/stage/ingest.js';

describe('isCleanRelativePath', () => {
  it.each([
    ['a.txt', true],
    ['dir/a.txt', true],
    ['', false],
    ['/abs', false],
    ['../x', false],
    ['a/../b', false],
    ['a\0b', false],
  ])('%s -> %s', (p, expected) => {
    expect(isCleanRelativePath(p)).toBe(expected);
  });
});

describe('validateInlineFiles', () => {
  it('accepts a small set of files', () => {
    expect(validateInlineFiles([{ path: 'a.txt', content: 'hi' }]).ok).toBe(true);
  });

  it('rejects a path that is not clean', () => {
    expect(validateInlineFiles([{ path: '../x', content: 'hi' }]).ok).toBe(false);
  });

  it('rejects a duplicate path', () => {
    const files = [
      { path: 'a.txt', content: '1' },
      { path: 'a.txt', content: '2' },
    ];
    expect(validateInlineFiles(files).ok).toBe(false);
  });

  it('rejects too many files or too many total bytes', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ path: `f${String(i)}`, content: 'x' }));
    expect(validateInlineFiles(many).ok).toBe(false);
  });

  it('never throws on arbitrary file lists', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ path: fc.string({ maxLength: 50 }), content: fc.string({ maxLength: 50 }) }),
        ),
        (files) => {
          expect(typeof validateInlineFiles(files).ok).toBe('boolean');
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('isUnderAnyRoot', () => {
  it('matches the root itself and anything strictly beneath it, nothing else', () => {
    const roots = ['/a/b'];
    expect(isUnderAnyRoot('/a/b', roots)).toBe(true);
    expect(isUnderAnyRoot('/a/b/c', roots)).toBe(true);
    expect(isUnderAnyRoot('/a/bc', roots)).toBe(false);
    expect(isUnderAnyRoot('/a', roots)).toBe(false);
  });
});

describe('resolveIngestSource', () => {
  const policy: IngestPolicy = { ingestRoots: ['/allowed'], ingestExcludes: [] };

  it('refuses a source outside every allowed root before ever calling fsop', async () => {
    let called = false;
    const fakeExecFile = ((...args: unknown[]) => {
      called = true;
      const cb = args[args.length - 1] as (e: Error | null) => void;
      cb(null);
    }) as NonNullable<IngestEnv['execFileFn']>;
    const env: IngestEnv = { fsopPath: '/bin/true', execFileFn: fakeExecFile };
    const r = await resolveIngestSource('/not-allowed', policy, env);
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('rejects a NUL byte before doing anything else', async () => {
    const r = await resolveIngestSource('/allowed/\0x', policy, { fsopPath: '/bin/true' });
    expect(r.ok).toBe(false);
  });

  it('still refuses when fsop itself refuses the re-check', async () => {
    // The source is realpath-able and within an allowed root on this machine (use /tmp as the
    // root so realpath succeeds everywhere this test runs), but fsop is told to refuse anyway.
    const env: IngestEnv = {
      fsopPath: '/bin/false',
    };
    const r = await resolveIngestSource('/tmp', { ingestRoots: ['/tmp'], ingestExcludes: [] }, env);
    expect(r.ok).toBe(false);
  });
});
