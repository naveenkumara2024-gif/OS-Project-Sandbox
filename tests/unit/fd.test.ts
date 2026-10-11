import { constants, fstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OwnedFd } from '../../src/util/fd.js';

let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aegis-fd-'));
  file = join(dir, 'f.txt');
  writeFileSync(file, 'x');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function isOpenFd(fd: number): boolean {
  try {
    fstatSync(fd);
    return true;
  } catch {
    return false;
  }
}

describe('OwnedFd', () => {
  it('opens and closes a descriptor', () => {
    const r = OwnedFd.open(file, constants.O_RDONLY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fd = r.value.fd;
    expect(isOpenFd(fd)).toBe(true);
    expect(r.value.close().ok).toBe(true);
    expect(isOpenFd(fd)).toBe(false);
    expect(r.value.isOpen).toBe(false);
  });

  it('close is idempotent', () => {
    const r = OwnedFd.open(file, constants.O_RDONLY);
    if (!r.ok) throw new Error('open failed');
    expect(r.value.close().ok).toBe(true);
    expect(r.value.close().ok).toBe(true);
  });

  it('throws when the descriptor is used after close', () => {
    const r = OwnedFd.open(file, constants.O_RDONLY);
    if (!r.ok) throw new Error('open failed');
    r.value.close();
    expect(() => r.value.fd).toThrow();
  });

  it('reports open failures as values', () => {
    const r = OwnedFd.open(join(dir, 'missing'), constants.O_RDONLY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('ENOENT');
  });

  it('release hands the descriptor over without closing it', () => {
    const r = OwnedFd.open(file, constants.O_RDONLY);
    if (!r.ok) throw new Error('open failed');
    const fd = r.value.release();
    expect(r.value.isOpen).toBe(false);
    expect(isOpenFd(fd)).toBe(true);
    // Re-adopt so the descriptor is closed by a guard, never leaked.
    expect(OwnedFd.adopt(fd).close().ok).toBe(true);
    expect(isOpenFd(fd)).toBe(false);
  });

  it('closes on scope exit with `using`', () => {
    let fd = -1;
    {
      const r = OwnedFd.open(file, constants.O_RDONLY);
      if (!r.ok) throw new Error('open failed');
      using guard = r.value;
      fd = guard.fd;
      expect(isOpenFd(fd)).toBe(true);
    }
    expect(isOpenFd(fd)).toBe(false);
  });
});
