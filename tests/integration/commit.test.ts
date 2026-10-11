import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitChanges, resolveCommitRoot } from '../../src/collect/commit.js';
import type { Change } from '../../src/collect/diff.js';
import { helperBuilds } from '../helpers/cell.js';

let upperDir = '';
let destDir = '';
beforeEach(() => {
  upperDir = mkdtempSync(join(tmpdir(), 'aegis-commit-upper-'));
  destDir = mkdtempSync(join(tmpdir(), 'aegis-commit-dest-'));
});
afterEach(() => {
  rmSync(upperDir, { recursive: true, force: true });
  rmSync(destDir, { recursive: true, force: true });
});

describe.each(helperBuilds())('aegis commit ($name build)', (helper) => {
  it('copies an approved add/modify through fsop and preserves the bytes', async () => {
    writeFileSync(join(upperDir, 'report.csv'), 'a,b\n1,2\n');
    writeFileSync(join(upperDir, 'nested.txt'), 'deep\n');
    mkdirSync(join(upperDir, 'sub'));
    writeFileSync(join(upperDir, 'sub', 'nested.txt'), 'deep\n');
    const changes: Change[] = [
      { path: 'report.csv', op: 'add', bytes: 8, sha256: 'x' },
      { path: 'sub/nested.txt', op: 'add', bytes: 5, sha256: 'y' },
    ];
    const outcomes = await commitChanges(destDir, upperDir, changes, null, {
      fsopPath: helper.path,
    });
    expect(outcomes).toEqual([
      { path: 'report.csv', status: 'committed', bytes: 8 },
      { path: 'sub/nested.txt', status: 'committed', bytes: 5 },
    ]);
    expect(readFileSync(join(destDir, 'report.csv'), 'utf8')).toBe('a,b\n1,2\n');
    expect(readFileSync(join(destDir, 'sub', 'nested.txt'), 'utf8')).toBe('deep\n');
  });

  it('refuses a path not in the requested subset, and reports nothing for it', async () => {
    writeFileSync(join(upperDir, 'a.txt'), 'a');
    writeFileSync(join(upperDir, 'b.txt'), 'b');
    const changes: Change[] = [
      { path: 'a.txt', op: 'add', bytes: 1, sha256: 'x' },
      { path: 'b.txt', op: 'add', bytes: 1, sha256: 'y' },
    ];
    const outcomes = await commitChanges(destDir, upperDir, changes, ['a.txt'], {
      fsopPath: helper.path,
    });
    expect(outcomes).toEqual([{ path: 'a.txt', status: 'committed', bytes: 1 }]);
    expect(() => readFileSync(join(destDir, 'b.txt'))).toThrow();
  });

  it('refuses a git hook without ever opening the destination', async () => {
    mkdirSync(join(upperDir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(upperDir, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nrm -rf ~\n');
    const changes: Change[] = [
      { path: '.git/hooks/post-checkout', op: 'add', bytes: 20, sha256: 'z' },
    ];
    const outcomes = await commitChanges(destDir, upperDir, changes, null, {
      fsopPath: helper.path,
    });
    expect(outcomes).toEqual([
      {
        path: '.git/hooks/post-checkout',
        status: 'refused',
        reason: 'git hooks are never committed',
      },
    ]);
    expect(() => readFileSync(join(destDir, '.git', 'hooks', 'post-checkout'))).toThrow();
  });

  it('refuses a symlink even when fsop is asked to copy it, via the diff metadata', async () => {
    const changes: Change[] = [
      {
        path: 'evil.txt',
        op: 'add',
        bytes: null,
        sha256: 'z',
        diff: 'symlink -> /etc/passwd',
      },
    ];
    const outcomes = await commitChanges(destDir, upperDir, changes, null, {
      fsopPath: helper.path,
    });
    expect(outcomes).toEqual([
      { path: 'evil.txt', status: 'refused', reason: 'symlinks are never committed' },
    ]);
  });

  it('fsop itself refuses a symlink even if the control-plane check were bypassed', async () => {
    // Direct test of the native layer, independent of the TypeScript policy filter above.
    const { symlinkSync } = await import('node:fs');
    symlinkSync('/etc/passwd', join(upperDir, 'sneaky.txt'));
    const { execFile } = await import('node:child_process');
    const exitCode = await new Promise<number>((resolve) => {
      execFile(
        helper.path,
        ['fsop', 'commit-copy', destDir, 'sneaky.txt', join(upperDir, 'sneaky.txt'), '1024'],
        (error) => {
          const code = (error as { code?: number } | null)?.code;
          resolve(code ?? 1);
        },
      );
    });
    expect(exitCode).not.toBe(0);
    expect(() => readFileSync(join(destDir, 'sneaky.txt'))).toThrow();
  });

  it('reports deletions without applying them', async () => {
    const changes: Change[] = [{ path: 'gone.txt', op: 'delete', bytes: null, sha256: null }];
    const outcomes = await commitChanges(destDir, upperDir, changes, null, {
      fsopPath: helper.path,
    });
    expect(outcomes[0]?.status).toBe('refused');
  });
});

describe('resolveCommitRoot', () => {
  it('accepts a root within the allowlist and refuses one outside it', async () => {
    const ok = await resolveCommitRoot(destDir, { commitRoots: [destDir] });
    expect(ok.ok).toBe(true);
    const outside = mkdtempSync(join(tmpdir(), 'aegis-commit-outside-'));
    try {
      const refused = await resolveCommitRoot(outside, { commitRoots: [destDir] });
      expect(refused.ok).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
