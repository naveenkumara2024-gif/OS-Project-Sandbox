import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitChanges } from '../../src/collect/commit.js';
import { diffOverlayUpper } from '../../src/collect/diff.js';
import { helperBuilds, request, runWith } from '../helpers/cell.js';
import { createFixture, snapshotTree, type Fixture } from './harness.js';

// Probe 15: the program's output file is a symlink to a secret (here the harness's decoy
// ~/.ssh/id_rsa). Layer expected to stop it: O_NOFOLLOW in fsop commit-copy, backed by the
// control plane's own refusal of anything the diff reports as a symlink.

let fixture: Fixture;
let wsParent = '';
beforeEach(() => {
  fixture = createFixture();
  wsParent = mkdtempSync(join(tmpdir(), 'aegis-p15-parent-'));
});
afterEach(() => {
  fixture.dispose();
  rmSync(wsParent, { recursive: true, force: true });
});

describe.each(helperBuilds())('probe 15: symlink output ($name build)', (helper) => {
  it('never copies the secret through a symlinked output file', async () => {
    const destDir = mkdtempSync(join(tmpdir(), 'aegis-p15-dest-'));
    try {
      const req = request(['/usr/bin/sh', '-c', `ln -s ${fixture.home}/.ssh/id_rsa leaked.txt`], {
        id: 'probe15',
        files: [{ path: 'README.md', content: 'ok\n' }],
      });
      const r = await runWith(helper, req, { workspaceParent: wsParent });
      expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });

      const wsDir = join(wsParent, `aegis-workspace-${req.id}`);
      const diff = diffOverlayUpper(join(wsDir, 'lower'), join(wsDir, 'rw', 'upper'));
      expect(diff.ok).toBe(true);
      if (!diff.ok) return;
      const symlinkChange = diff.value.find((c) => c.path === 'leaked.txt');
      expect(symlinkChange?.diff).toContain('.ssh/id_rsa');

      const outcomes = await commitChanges(destDir, join(wsDir, 'rw', 'upper'), diff.value, null, {
        fsopPath: helper.path,
      });
      const outcome = outcomes.find((o) => o.path === 'leaked.txt');
      expect(outcome?.status).toBe('refused');

      // The control: nothing in the destination fixture, and the decoy key is unchanged.
      expect(readdirSync(destDir).filter((n) => n !== 'README.md')).not.toContain('leaked.txt');
      expect(readFileSync(join(fixture.home, '.ssh', 'id_rsa'), 'utf8')).toContain(
        'FAKE-PRIVATE-KEY-DECOY',
      );
      expect(snapshotTree(fixture.root)).toEqual(new Map(fixture.snapshot));
    } finally {
      rmSync(destDir, { recursive: true, force: true });
    }
  });
});
