import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TempDir } from '../../src/util/tempdir.js';

let parent = '';
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'aegis-test-'));
});
afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

describe('TempDir', () => {
  it('creates a private directory and removes it with its subdirectories', () => {
    let path = '';
    {
      using d = unwrap(TempDir.create('cell', parent));
      path = d.path;
      const sub = d.mkdir('root');
      expect(sub.ok).toBe(true);
      expect(existsSync(path)).toBe(true);
    }
    expect(existsSync(path)).toBe(false);
  });

  it('removes on an exception path', () => {
    let path = '';
    expect(() => {
      using d = unwrap(TempDir.create('cell', parent));
      path = d.path;
      throw new Error('boom');
    }).toThrow('boom');
    expect(existsSync(path)).toBe(false);
  });

  it('is never recursive: unexpected content makes disposal fail and is left alone', () => {
    const d = unwrap(TempDir.create('cell', parent));
    writeFileSync(join(d.path, 'surprise'), 'x');
    expect(() => {
      d[Symbol.dispose]();
    }).toThrow();
    expect(existsSync(join(d.path, 'surprise'))).toBe(true);
  });

  it('rejects names that could escape', () => {
    using d = unwrap(TempDir.create('cell', parent));
    for (const n of ['..', '.', 'a/b', '', 'x'.repeat(40)]) {
      expect(d.mkdir(n).ok, n).toBe(false);
    }
    expect(TempDir.create('../x', parent).ok).toBe(false);
  });
});

function unwrap(r: ReturnType<typeof TempDir.create>): TempDir {
  if (!r.ok) throw new Error(r.error.context);
  return r.value;
}
