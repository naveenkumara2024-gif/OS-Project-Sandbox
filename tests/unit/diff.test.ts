import {
  mkdirSync,
  mkdtempSync,
  mkdirSync as mkdir2,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffCopyResult, diffOverlayUpper, treeBytes } from '../../src/collect/diff.js';

let base = '';
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aegis-diff-test-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function mk(dir: string): string {
  const p = join(base, dir);
  mkdirSync(p, { recursive: true });
  return p;
}

describe('diffOverlayUpper', () => {
  it('classifies add, modify and delete from a real overlay-style upper directory', () => {
    const lower = mk('lower');
    const upper = mk('upper');
    writeFileSync(join(lower, 'unchanged.txt'), 'same\n');
    writeFileSync(join(lower, 'old.txt'), 'before\n');
    writeFileSync(join(upper, 'old.txt'), 'after\n');
    writeFileSync(join(upper, 'new.txt'), 'brand new\n');
    // A real whiteout: character device major/minor 0,0 (mknod needs no privilege for this).
    execSync(`mknod ${join(upper, 'deleted.txt')} c 0 0`);

    const r = diffOverlayUpper(lower, upper);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byPath = new Map(r.value.map((c) => [c.path, c]));
    expect(byPath.get('old.txt')?.op).toBe('modify');
    expect(byPath.get('new.txt')?.op).toBe('add');
    expect(byPath.get('deleted.txt')?.op).toBe('delete');
    expect(byPath.has('unchanged.txt')).toBe(false);
  });

  it('records a symlink as a change without reading through it', () => {
    const lower = mk('lower');
    const upper = mk('upper');
    symlinkSync('/etc/passwd', join(upper, 'link.txt'));
    const r = diffOverlayUpper(lower, upper);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const link = r.value.find((c) => c.path === 'link.txt');
    expect(link?.op).toBe('add');
    expect(link?.diff).toContain('/etc/passwd');
    expect(link?.bytes).toBeNull();
  });

  it('descends into subdirectories', () => {
    const lower = mk('lower');
    const upper = mk('upper');
    mkdir2(join(upper, 'sub'), { recursive: true });
    writeFileSync(join(upper, 'sub', 'deep.txt'), 'x\n');
    const r = diffOverlayUpper(lower, upper);
    expect(r.ok && r.value.map((c) => c.path)).toEqual(['sub/deep.txt']);
  });
});

describe('diffCopyResult', () => {
  it('compares two full trees for add, modify and delete', () => {
    const lower = mk('lower');
    const result = mk('result');
    writeFileSync(join(lower, 'same.txt'), 'x\n');
    writeFileSync(join(result, 'same.txt'), 'x\n');
    writeFileSync(join(lower, 'gone.txt'), 'x\n');
    writeFileSync(join(result, 'changed.txt'), 'before\n');
    writeFileSync(join(lower, 'changed.txt'), 'after\n');
    writeFileSync(join(result, 'added.txt'), 'new\n');

    const r = diffCopyResult(lower, result);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byPath = new Map(r.value.map((c) => [c.path, c]));
    expect(byPath.get('gone.txt')?.op).toBe('delete');
    expect(byPath.get('changed.txt')?.op).toBe('modify');
    expect(byPath.get('added.txt')?.op).toBe('add');
    expect(byPath.has('same.txt')).toBe(false);
  });
});

describe('treeBytes', () => {
  it('sums regular files, counts a symlink as nothing, and stops early past the cap', () => {
    const d = mk('tree');
    writeFileSync(join(d, 'a'), 'x'.repeat(100));
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'sub', 'b'), 'y'.repeat(50));
    symlinkSync('/etc/passwd', join(d, 'link'));
    expect(treeBytes(d, 1_000_000)).toBe(150);
    expect(treeBytes(d, 10)).toBeGreaterThan(10);
  });
});
