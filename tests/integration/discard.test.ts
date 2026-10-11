import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discardWorkspace } from '../../src/collect/discard.js';
import { helperBuilds, request, runWith } from '../helpers/cell.js';

let wsParent = '';
let destDir = '';
beforeEach(() => {
  wsParent = mkdtempSync(join(tmpdir(), 'aegis-discard-parent-'));
  destDir = mkdtempSync(join(tmpdir(), 'aegis-discard-dest-'));
});
afterEach(() => {
  rmSync(wsParent, { recursive: true, force: true });
  rmSync(destDir, { recursive: true, force: true });
});

describe.each(helperBuilds())('aegis discard ($name build)', (helper) => {
  it('removes a real overlay workspace, including the kernel-created work/work, cleanly', async () => {
    const req = request(['/usr/bin/sh', '-c', 'echo x > a.txt'], {
      id: 'discard-overlay',
      files: [{ path: 'seed.txt', content: 'x' }],
    });
    const r = await runWith(helper, req, { workspaceParent: wsParent });
    expect(r.termination).toEqual({ cause: 'exit' });
    const dir = join(wsParent, `aegis-workspace-${req.id}`);
    expect(existsSync(dir)).toBe(true);

    const discarded = discardWorkspace({ dir });
    expect(discarded.ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('removes a copy-mode workspace cleanly too', async () => {
    const req = request(['/usr/bin/true'], {
      id: 'discard-copy',
      files: [{ path: 'seed.txt', content: 'x' }],
    });
    const r = await runWith(helper, req, { workspaceParent: wsParent, forceCopyWorkspace: true });
    expect(r.workspace).toBe('copy');
    const dir = join(wsParent, `aegis-workspace-${req.id}`);
    expect(discardWorkspace({ dir }).ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('never touches a commit destination, even one that happens to sit elsewhere', async () => {
    mkdirSync(join(destDir, 'sub'), { recursive: true });
    writeFileSync(join(destDir, 'keep.txt'), 'keep me');
    const req = request(['/usr/bin/true'], {
      id: 'discard-no-touch',
      files: [{ path: 'seed.txt', content: 'x' }],
    });
    await runWith(helper, req, { workspaceParent: wsParent });
    discardWorkspace({ dir: join(wsParent, `aegis-workspace-${req.id}`) });
    expect(readFileSync(join(destDir, 'keep.txt'), 'utf8')).toBe('keep me');
  });

  it('is a success, not an error, when there is nothing to discard', () => {
    const r = discardWorkspace({ dir: join(wsParent, 'aegis-workspace-never-ran') });
    expect(r.ok).toBe(true);
  });
});
