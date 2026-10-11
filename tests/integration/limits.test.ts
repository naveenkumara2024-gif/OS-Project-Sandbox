import { mkdirSync, mkdtempSync, readdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensureParent,
  locateDelegation,
  pidIsAlive,
  realCgroupFs,
  reapOrphanCells,
} from '../../src/launch/cgroup.js';
import { RECEIPT_LAYERS } from '../../src/probe/isolation.js';
import { superviseCell } from '../../src/supervise/cell-supervisor.js';
import { encodeLaunchSpec } from '../../src/sys/launch-spec.js';
import { parseStatus } from '../../src/sys/status.js';
import { OwnedFd } from '../../src/util/fd.js';
import { reapStaleTempDirs } from '../../src/util/tempdir.js';
import { helperBuilds, request, runIn, runWith, sh } from '../helpers/cell.js';
import { constants as fsc, readFileSync } from 'node:fs';

// needs_userns and needs_cgroup: the engine must run inside a delegated subtree, which `npm test`
// arranges through scripts/run-in-scope.mjs. If it does not, these fail with the hint; they are
// never skipped (CLAUDE.md 7).

function cellParentPath(): string {
  const fs = realCgroupFs();
  const del = locateDelegation(
    fs,
    process.getuid?.() ?? -1,
    readFileSync('/proc/self/cgroup', 'utf8'),
  );
  if (!del.ok) throw new Error(`not inside a delegated cgroup: ${del.error.context}`);
  const parent = ensureParent(fs, del.value.root);
  if (!parent.ok) throw new Error(parent.error.context);
  return parent.value.path;
}

function myCells(): string[] {
  return readdirSync(cellParentPath()).filter((n) => n.startsWith(`cell-${String(process.pid)}-`));
}

describe.each(helperBuilds())('limits and receipt ($name build)', (helper) => {
  it('applies the requested limits, echoes them, and reports a level-2 receipt', async () => {
    const r = await runIn(
      helper,
      request(['/usr/bin/true'], {
        limits: {
          memory_mb: 64,
          pids: 32,
          cpu_percent: 50,
          cpu_ms: 5000,
          disk_mb: 4,
          wall_ms: 5000,
        },
      }),
    );
    expect(r.termination).toEqual({ cause: 'exit' });
    expect(r.limits).toMatchObject({
      memory_mb: 64,
      pids: 32,
      cpu_percent: 50,
      cpu_ms: 5000,
      disk_mb: 4,
      wall_ms: 5000,
    });
    expect(r.isolation.level).toBe(2);
    for (const l of RECEIPT_LAYERS) expect(r.isolation.layers[l], l).toBe(true);
    // Measured from the cgroup, so the helper really was inside it.
    expect(r.usage.memory_peak_bytes).toBeGreaterThan(0);
    expect(r.usage.memory_peak_bytes).toBeLessThan(64 * 1024 * 1024);
    expect(r.usage.pids_peak).toBeGreaterThanOrEqual(2);
    expect(r.usage.cpu_ms).toBeGreaterThanOrEqual(0);
    expect(r.limits_hit).toEqual([]);
    expect(r.hint).toBeNull();
  });

  it('makes the cell cgroup the cgroup namespace root', async () => {
    const r = await sh(helper, 'cat /proc/self/cgroup');
    expect(r.stdout.trim()).toBe('0::/');
  });

  it('applies the capped /tmp size from the request', async () => {
    const r = await sh(helper, "df -k /tmp | tail -1 | tr -s ' ' | cut -d' ' -f2", {
      limits: { disk_mb: 8 },
    });
    expect(Number(r.stdout.trim())).toBe(8 * 1024);
  });

  it('leaves no cell cgroup behind after any termination cause', async () => {
    const before = myCells();
    await runIn(helper, request(['/usr/bin/true']));
    await sh(helper, 'exit 3');
    await sh(helper, 'sleep 30', { limits: { wall_ms: 300 } });
    await sh(helper, 'yes', { limits: { output_kb: 1 } });
    expect(myCells()).toEqual(before);
  });

  it('refuses before running anything when the engine is outside a delegated subtree', async () => {
    const r = await runWith(helper, request(['/usr/bin/echo', 'MUST-NOT-RUN']), {
      selfCgroupText: '0::/init.scope\n',
    });
    expect(r.termination).toMatchObject({
      cause: 'isolation_unavailable',
      layer: 'cgroup_placement',
    });
    expect(r.error).toMatchObject({ code: 'isolation_unavailable', layer: 'cgroup_placement' });
    expect(r.stdout).toBe('');
    expect(r.hint).toContain('systemd-run --user --scope');
    // A receipt is present even in a refusal, and it claims nothing it did not establish.
    expect(r.isolation.level).toBe(0);
    expect(Object.values(r.isolation.layers).some(Boolean)).toBe(false);
  });
});

describe.each(helperBuilds())('kernel refusal of placement ($name build)', (helper) => {
  it('is reported as the cgroup_placement layer, and no payload starts', async () => {
    // The root cgroup is not writable by this user, so clone3(CLONE_INTO_CGROUP) into it is
    // refused by the kernel with EACCES: the same refusal a process in /init.scope would get.
    const fd = OwnedFd.open('/sys/fs/cgroup', fsc.O_RDONLY | fsc.O_DIRECTORY);
    if (!fd.ok) throw new Error(fd.error.context);
    using owned = fd.value;
    const spec = encodeLaunchSpec({
      argv: ['/usr/bin/echo', 'MUST-NOT-RUN'],
      env: ['PATH=/usr/bin:/bin'],
      rootMountpoint: '/tmp/aegis-never-created/root',
      hostname: 'aegis',
      rootTmpfsBytes: 64 * 1024 * 1024,
      tmpTmpfsBytes: 16 * 1024 * 1024,
      entries: [],
      maskFiles: [],
      maskDirs: [],
      cgroupFd: true,
    });
    if (!spec.ok) throw new Error(spec.error.context);
    const r = await superviseCell({
      helper: helper.path,
      spec: spec.value,
      wallMs: 5000,
      maxOutputBytes: 4096,
      cgroupFd: owned.fd,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stdout.toString()).not.toContain('MUST-NOT-RUN');
    const recs = parseStatus(r.value.status);
    expect(recs.ok && recs.value).toContainEqual({
      kind: 'layer',
      layer: 'cgroup_placement',
      ok: false,
      errno: 13,
    });
    expect(recs.ok && recs.value.some((x) => x.kind === 'started')).toBe(false);
  });
});

describe('orphan reaper (real cgroups and directories)', () => {
  it("removes a dead pid's cell cgroup and temp dir, and leaves a live pid's alone", async () => {
    const fs = realCgroupFs();
    const parent = cellParentPath();
    const deadPid = 2 ** 22 - 7;
    expect(pidIsAlive(deadPid)).toBe(false);
    const dead = join(parent, `cell-${String(deadPid)}-deadbeef`);
    const live = join(parent, `cell-${String(process.pid)}-cafef00d`);
    mkdirSync(dead);
    mkdirSync(live);

    const r = await reapOrphanCells(fs, parent);
    expect(r.removed).toBeGreaterThanOrEqual(1);
    expect(readdirSync(parent)).not.toContain(`cell-${String(deadPid)}-deadbeef`);
    expect(readdirSync(parent)).toContain(`cell-${String(process.pid)}-cafef00d`);
    rmdirSync(live);

    const tmp = mkdtempSync(join(tmpdir(), 'aegis-reaper-'));
    mkdirSync(join(tmp, `aegis-cell-${String(deadPid)}-abc123`));
    mkdirSync(join(tmp, `aegis-cell-${String(deadPid)}-def456`));
    mkdirSync(join(tmp, `aegis-cell-${String(deadPid)}-def456`, 'root'));
    mkdirSync(join(tmp, `aegis-cell-${String(process.pid)}-live00`));
    const t = reapStaleTempDirs(tmp, pidIsAlive);
    expect(t.removed).toBe(2);
    expect(readdirSync(tmp)).toEqual([`aegis-cell-${String(process.pid)}-live00`]);
    rmdirSync(join(tmp, `aegis-cell-${String(process.pid)}-live00`));
    rmdirSync(tmp);
  });
});
