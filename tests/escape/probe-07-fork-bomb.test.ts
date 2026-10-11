import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { helperBuilds, request, requireCgroupLimits, runIn } from '../helpers/cell.js';

// Probe 7: fork bomb. Layer expected to stop it: the pids cgroup controller (pids.max), with the
// supervisor killing the cell on the first refused fork. Runs only after the self-test proved the
// limit is active (CLAUDE.md 6.5).

/**
 * Processes still sitting in a cell cgroup created by this worker. Counting all host processes
 * would be wrong here: other test files run cells concurrently in the same machine.
 */
function survivorsOfThisWorker(): string[] {
  const tag = `/aegis-cells/cell-${String(process.pid)}-`;
  const out: string[] = [];
  for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      if (readFileSync(`/proc/${pid}/cgroup`, 'utf8').includes(tag)) out.push(pid);
    } catch {
      // The process exited between listing and reading.
    }
  }
  return out;
}

describe.each(helperBuilds())('probe 7: fork bomb ($name build)', (helper) => {
  it('is stopped by the pids limit and leaves the host as it was', async () => {
    await requireCgroupLimits(helper);
    const t0 = Date.now();
    const r = await runIn(
      helper,
      request(
        [
          '/usr/bin/sh',
          '-c', // The payload stays alive after starting the bomb; if it exited, init would end the cell
          // (and every descendant) at once, which is correct but would not exercise the limit.
          'bomb() { bomb | bomb & }; bomb; sleep 60',
        ],
        {
          limits: { pids: 64, wall_ms: 20000 },
        },
      ),
    );
    const took = Date.now() - t0;
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'pids_limit' });
    expect(r.limits_hit).toContain('pids');
    expect(r.usage.pids_peak).toBeLessThanOrEqual(64);
    expect(r.usage.pids_peak).toBeGreaterThan(8);
    expect(r.hint).toContain('64 process limit');
    expect(r.isolation.layers.cgroup_pids).toBe(true);
    expect(took).toBeLessThan(10000);

    // Nothing from the bomb survives: no process is left in any of this worker's cell cgroups.
    await new Promise((res) => setTimeout(res, 200));
    expect(survivorsOfThisWorker()).toEqual([]);
  });
});
