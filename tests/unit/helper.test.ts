import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NATIVE_FACT_KEYS,
  findRepoRoot,
  locateHelper,
  parseHelperProbe,
} from '../../src/sys/helper.js';

function facts(): Record<string, unknown> {
  return {
    clone3: { value: true, source: 'syscall:clone3(size=0)', errno: 22 },
    openat2_resolve_beneath: { value: true, source: 'syscall:openat2', errno: null },
    pidfd_open: { value: true, source: 'syscall:pidfd_open(self)', errno: null },
    landlock_abi_version: { value: null, source: 'syscall:landlock', errno: 38 },
    seccomp_mode: { value: 0, source: 'prctl:PR_GET_SECCOMP', errno: null },
    no_new_privs: { value: 0, source: 'prctl:PR_GET_NO_NEW_PRIVS', errno: null },
    unshare_newuser: { value: true, source: 'fork+unshare(CLONE_NEWUSER)', errno: null },
  };
}

function line(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 1,
    helper: 'aegis-cell',
    helper_version: '0.0.0',
    facts: facts(),
    ...overrides,
  });
}

describe('parseHelperProbe', () => {
  it('accepts the documented shape', () => {
    const r = parseHelperProbe(line());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.helperVersion).toBe('0.0.0');
    expect(r.value.facts.clone3).toEqual({
      value: true,
      source: 'syscall:clone3(size=0)',
      errno: 22,
    });
    expect(Object.keys(r.value.facts).sort()).toEqual([...NATIVE_FACT_KEYS].sort());
  });

  it('rejects non-JSON', () => {
    expect(parseHelperProbe('not json').ok).toBe(false);
    expect(parseHelperProbe('').ok).toBe(false);
  });

  it('rejects a wrong schema version or helper name', () => {
    expect(parseHelperProbe(line({ schema: 2 })).ok).toBe(false);
    expect(parseHelperProbe(line({ helper: 'other' })).ok).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    expect(parseHelperProbe(line({ extra: 1 })).ok).toBe(false);
  });

  it('rejects a missing or extra fact', () => {
    const missing = facts();
    delete missing['clone3'];
    expect(parseHelperProbe(line({ facts: missing })).ok).toBe(false);
    expect(parseHelperProbe(line({ facts: { ...facts(), extra: facts()['clone3'] } })).ok).toBe(
      false,
    );
  });

  it('rejects facts with the wrong types', () => {
    const bad = facts();
    bad['clone3'] = { value: 'yes', source: 's', errno: null };
    expect(parseHelperProbe(line({ facts: bad })).ok).toBe(false);
    bad['clone3'] = { value: true, source: 's', errno: 'EINVAL' };
    expect(parseHelperProbe(line({ facts: bad })).ok).toBe(false);
    bad['clone3'] = { value: true, source: 's', errno: null, extra: 1 };
    expect(parseHelperProbe(line({ facts: bad })).ok).toBe(false);
  });
});

describe('locateHelper', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it('uses an absolute override and reports its source', () => {
    const r = locateHelper({ AEGIS_CELL_BIN: '/opt/aegis/aegis-cell' }, here);
    expect(r).toEqual({
      ok: true,
      value: { path: '/opt/aegis/aegis-cell', source: 'env:AEGIS_CELL_BIN' },
    });
  });

  it('rejects a relative override', () => {
    const r = locateHelper({ AEGIS_CELL_BIN: 'aegis-cell' }, here);
    expect(r.ok).toBe(false);
  });

  it('defaults to the release build under the repository root', () => {
    const r = locateHelper({}, here);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.source).toBe('repo:native/build/release');
    expect(r.value.path.endsWith(join('native', 'build', 'release', 'aegis-cell'))).toBe(true);
  });
});

describe('findRepoRoot', () => {
  it('finds the directory holding package.json and native/', () => {
    const root = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
    expect(root).not.toBeNull();
    if (root === null) return;
    expect(existsSync(join(root, 'package.json'))).toBe(true);
    expect(existsSync(join(root, 'native'))).toBe(true);
  });
});
