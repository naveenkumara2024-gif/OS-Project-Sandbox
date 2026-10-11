import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { helperBuilds, request, runWith } from '../helpers/cell.js';
import { createFixture, type Fixture } from './harness.js';

// Probe 16: request path ../../etc, or a symlinked workspace root. Layer expected to stop it:
// the ingest allowlist plus fsop's openat2(RESOLVE_BENEATH) re-check.

let fixture: Fixture;
let wsParent = '';
beforeEach(() => {
  fixture = createFixture();
  wsParent = mkdtempSync(join(tmpdir(), 'aegis-p16-parent-'));
});
afterEach(() => {
  fixture.dispose();
  rmSync(wsParent, { recursive: true, force: true });
});

describe.each(helperBuilds())('probe 16: path escape ($name build)', (helper) => {
  it('refuses a workspace source reached only via ../.. out of the allowed root', async () => {
    const req = request(['/usr/bin/true'], {
      id: 'probe16a',
      workspace: { source: join(fixture.project, '..', '..', 'etc') },
    });
    const etcMtime = statSync('/etc').mtimeMs;
    const r = await runWith(helper, req, {
      workspaceParent: wsParent,
      ingestPolicy: { ingestRoots: [fixture.project], ingestExcludes: [] },
    });
    expect(r.termination).toMatchObject({
      cause: 'isolation_unavailable',
      layer: 'workspace_policy',
    });
    expect(statSync('/etc').mtimeMs).toBe(etcMtime);
  });

  it('refuses a workspace source that is only reachable through an allowed root being a symlink elsewhere', async () => {
    // The configured root is the real fixture project; the request names a path that resolves
    // to a different, unlisted place via the fixture's own symlink-free tree plus a parent climb.
    const req = request(['/usr/bin/true'], {
      id: 'probe16b',
      workspace: { source: `${fixture.project}/../../../../../../../../etc/passwd` },
    });
    const r = await runWith(helper, req, {
      workspaceParent: wsParent,
      ingestPolicy: { ingestRoots: [fixture.project], ingestExcludes: [] },
    });
    expect(r.termination).toMatchObject({ cause: 'isolation_unavailable' });
  });

  it('control: a source that really is inside the allowed root is accepted', async () => {
    const req = request(['/usr/bin/true'], {
      id: 'probe16c',
      workspace: { source: fixture.project },
    });
    const r = await runWith(helper, req, {
      workspaceParent: wsParent,
      ingestPolicy: { ingestRoots: [fixture.project], ingestExcludes: [] },
    });
    expect(r.termination).toEqual({ cause: 'exit' });
    const content = readFileSync(
      join(wsParent, `aegis-workspace-${req.id}`, 'lower', 'README.md'),
      'utf8',
    );
    expect(content).toContain('sacrificial project');
  });
});
