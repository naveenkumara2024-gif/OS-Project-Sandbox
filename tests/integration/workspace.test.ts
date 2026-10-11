import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCell } from '../../src/launch/run-cell.js';
import { realPlanEnv } from '../../src/launch/rootfs-plan.js';
import { helperBuilds, request, runWith } from '../helpers/cell.js';

// needs_userns / needs_overlay: these create real cells with a real workspace. A missing feature
// fails loudly; it is never silently skipped (CLAUDE.md 7).

let fixtureSrc = '';
let wsParent = '';
let nextId = 0;
function uniqueRequest(command: string[], extra: Record<string, unknown> = {}) {
  nextId += 1;
  return request(command, { ...extra, id: `ws-test-${String(nextId)}` });
}
beforeEach(() => {
  fixtureSrc = mkdtempSync(join(tmpdir(), 'aegis-ws-src-'));
  wsParent = mkdtempSync(join(tmpdir(), 'aegis-ws-parent-'));
  writeFileSync(join(fixtureSrc, 'pre-existing.txt'), 'hi\n');
  mkdirSync(join(fixtureSrc, 'sub'));
  writeFileSync(join(fixtureSrc, 'sub', 'deep.txt'), 'deep\n');
});
/** overlayfs's kernel-created rw/work/work is mode 0000; chmod it before a recursive remove, or
 * rmSync's readdir hits EACCES (the same thing discardWorkspace guards against in production). */
function cleanupWorkspaceParent(parent: string): void {
  try {
    for (const name of readdirSync(parent)) {
      try {
        chmodSync(join(parent, name, 'rw', 'work', 'work'), 0o700);
      } catch {
        // Not every entry is a workspace with an overlay work dir.
      }
    }
  } catch {
    // The parent may not exist yet.
  }
  rmSync(parent, { recursive: true, force: true });
}

afterEach(() => {
  rmSync(fixtureSrc, { recursive: true, force: true });
  cleanupWorkspaceParent(wsParent);
});

describe.each(helperBuilds())('workspace ($name build)', (helper) => {
  it("a files-only request runs and the diff shows only the program's own writes", async () => {
    const r = await runWith(
      helper,
      uniqueRequest(['/usr/bin/sh', '-c', 'echo x >> a.txt; rm a.txt'], {
        files: [{ path: 'a.txt', content: 'start\n' }],
      }),
      { workspaceParent: wsParent },
    );
    expect(r.termination).toEqual({ cause: 'exit' });
    expect(r.workspace === 'overlay' || r.workspace === 'copy').toBe(true);
    expect(r.changes).toEqual([{ path: 'a.txt', op: 'delete', bytes: null, sha256: null }]);
  });

  it('ingests a host directory and reports an exact, hashed change list for both modes', async () => {
    for (const forceCopy of [false, true]) {
      const r = await runWith(
        helper,
        uniqueRequest(
          [
            '/usr/bin/sh',
            '-c',
            'echo appended >> pre-existing.txt; echo new > added.txt; rm sub/deep.txt',
          ],
          {
            workspace: { source: fixtureSrc },
          },
        ),
        {
          workspaceParent: wsParent,
          forceCopyWorkspace: forceCopy,
          ingestPolicy: { ingestRoots: [fixtureSrc], ingestExcludes: [] },
        },
      );
      expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
      expect(r.workspace).toBe(forceCopy ? 'copy' : 'overlay');
      const byPath = new Map((r.changes ?? []).map((c) => [c.path, c]));
      expect(byPath.get('pre-existing.txt')?.op).toBe('modify');
      expect(byPath.get('added.txt')?.op).toBe('add');
      expect(byPath.get('sub/deep.txt')?.op).toBe('delete');
      const upperFile = join(wsParent, `aegis-workspace-${r.id}`, 'rw', 'upper', 'added.txt');
      expect(readFileSync(upperFile, 'utf8')).toBe('new\n');
    }
  });

  it('refuses an ingest source outside every allowed root, with no host-fs effect', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'aegis-ws-outside-'));
    try {
      const r = await runWith(
        helper,
        uniqueRequest(['/usr/bin/echo', 'MUST-NOT-RUN'], { workspace: { source: outside } }),
        {
          workspaceParent: wsParent,
          ingestPolicy: { ingestRoots: [fixtureSrc], ingestExcludes: [] },
        },
      );
      expect(r.termination).toMatchObject({
        cause: 'isolation_unavailable',
        layer: 'workspace_policy',
      });
      expect(r.stdout).toBe('');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('level reaches 3 only when overlay (not copy) actually mounted', async () => {
    const overlay = await runWith(
      helper,
      uniqueRequest(['/usr/bin/true'], { files: [{ path: 'a.txt', content: 'x' }] }),
      { workspaceParent: wsParent, forceCopyWorkspace: false },
    );
    expect(overlay.isolation.level).toBe(3);
    const copy = await runWith(
      helper,
      uniqueRequest(['/usr/bin/true'], { files: [{ path: 'a.txt', content: 'x' }] }),
      { workspaceParent: wsParent, forceCopyWorkspace: true },
    );
    expect(copy.isolation.level).toBe(2);
    expect(copy.isolation.layers.overlay).toBe(false);
  });
});

describe('workspace control-plane behaviour (no cell needed)', () => {
  it('runCell is an error, not a receipt, when the workspace directory cannot be created', async () => {
    const helper = helperBuilds()[0];
    if (helper === undefined) throw new Error('no helper build available');
    const notADirectory = join(wsParent, 'blocker');
    writeFileSync(notADirectory, 'x');
    const r = await runCell(request(['/usr/bin/true'], { files: [{ path: 'a', content: 'x' }] }), {
      helperPath: helper.path,
      planEnv: realPlanEnv(),
      workspaceParent: notADirectory,
    });
    expect(r.ok).toBe(false);
  });
});
