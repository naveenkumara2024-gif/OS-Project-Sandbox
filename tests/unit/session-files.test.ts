import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkUpperEntry,
  isWhiteoutStat,
  writeFilesToUpper,
  type UpperEntryStat,
} from '../../src/stage/session-files.js';

let upper = '';
beforeEach(() => {
  upper = mkdtempSync(join(tmpdir(), 'aegis-upper-'));
});
afterEach(() => {
  rmSync(upper, { recursive: true, force: true });
});

const stat = (over: Partial<UpperEntryStat>): UpperEntryStat => ({
  isDirectory: () => false,
  isFile: () => false,
  isSymbolicLink: () => false,
  isCharacterDevice: () => false,
  rdev: 0,
  ...over,
});

describe('writeFilesToUpper', () => {
  it('writes new files, creates parents, and overwrites an existing regular file', () => {
    mkdirSync(join(upper, 'sub'));
    writeFileSync(join(upper, 'sub', 'old.txt'), 'old');
    const r = writeFilesToUpper(upper, [
      { path: 'a.txt', content: 'A' },
      { path: 'deep/er/b.txt', content: 'B' },
      { path: 'sub/old.txt', content: 'new' },
    ]);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(upper, 'a.txt'), 'utf8')).toBe('A');
    expect(readFileSync(join(upper, 'deep/er/b.txt'), 'utf8')).toBe('B');
    expect(readFileSync(join(upper, 'sub/old.txt'), 'utf8')).toBe('new');
  });

  it('refuses a symlink in the way (target or parent) and writes nothing at all', () => {
    const outside = mkdtempSync(join(tmpdir(), 'aegis-outside-'));
    try {
      symlinkSync(join(outside, 'target.txt'), join(upper, 'link'));
      symlinkSync(outside, join(upper, 'dirlink'));
      for (const path of ['link', 'dirlink/x.txt']) {
        const r = writeFilesToUpper(upper, [
          { path: 'fine.txt', content: 'ok' },
          { path: path, content: 'evil' },
        ]);
        expect(r.ok, path).toBe(false);
      }
      expect(() => readFileSync(join(upper, 'fine.txt'))).toThrow(); // all-or-nothing
      expect(() => readFileSync(join(outside, 'target.txt'))).toThrow();
      expect(() => readFileSync(join(outside, 'x.txt'))).toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a directory where a file is wanted, and a file where a directory is wanted', () => {
    mkdirSync(join(upper, 'dir'));
    writeFileSync(join(upper, 'file'), 'x');
    expect(writeFilesToUpper(upper, [{ path: 'dir', content: 'x' }]).ok).toBe(false);
    expect(writeFilesToUpper(upper, [{ path: 'file/inner.txt', content: 'x' }]).ok).toBe(false);
  });

  it('rejects unclean paths through the shared validation', () => {
    for (const path of ['../x', '/abs', 'a//b', './a', '']) {
      expect(writeFilesToUpper(upper, [{ path, content: 'x' }]).ok, path).toBe(false);
    }
  });

  it('refuses a whiteout at the target or at a parent (checked with injected stat results)', () => {
    const whiteout = stat({ isCharacterDevice: () => true, rdev: 0 });
    const dir = stat({ isDirectory: () => true });
    const lstatTarget = (p: string): UpperEntryStat | null =>
      p.endsWith('/gone.txt') ? whiteout : null;
    const r1 = writeFilesToUpper(upper, [{ path: 'gone.txt', content: 'x' }], lstatTarget);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.context).toContain('whiteout');
    const lstatParent = (p: string): UpperEntryStat | null =>
      p.endsWith('/gonedir') ? whiteout : p === upper ? dir : null;
    expect(
      writeFilesToUpper(upper, [{ path: 'gonedir/f.txt', content: 'x' }], lstatParent).ok,
    ).toBe(false);
  });
});

describe('checkUpperEntry', () => {
  it('classifies the entries a write can meet', () => {
    expect(isWhiteoutStat(stat({ isCharacterDevice: () => true, rdev: 0 }))).toBe(true);
    expect(isWhiteoutStat(stat({ isCharacterDevice: () => true, rdev: 5 }))).toBe(false);
    expect(checkUpperEntry(stat({ isFile: () => true }), true).ok).toBe(true);
    expect(checkUpperEntry(stat({ isDirectory: () => true }), false).ok).toBe(true);
    expect(checkUpperEntry(stat({ isDirectory: () => true }), true).ok).toBe(false);
    expect(checkUpperEntry(stat({ isFile: () => true }), false).ok).toBe(false);
    expect(checkUpperEntry(stat({ isSymbolicLink: () => true }), true).ok).toBe(false);
  });
});
