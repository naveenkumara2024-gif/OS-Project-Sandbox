import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { helperBuilds, request, requireCgroupLimits, runIn } from '../helpers/cell.js';

// Probe 8: allocate 4 GB. Layer expected to stop it: the memory cgroup (memory.max with
// memory.oom.group, swap off). Runs only after the self-test proved the limit is active.

function memAvailableMb(): number {
  const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
  return Math.round(Number(m?.[1] ?? 0) / 1024);
}

describe.each(helperBuilds())('probe 8: allocate 4 GB ($name build)', (helper) => {
  it('is OOM-killed at the limit, with the numbers to prove it', async () => {
    await requireCgroupLimits(helper);
    const before = memAvailableMb();
    const r = await runIn(
      helper,
      request(
        [
          '/usr/bin/python3',
          '-c',
          'b = bytearray(4 << 30)\nfor i in range(0, len(b), 4096): b[i] = 1\nprint("ALLOCATED-4GB")',
        ],
        { limits: { memory_mb: 256, wall_ms: 30000 } },
      ),
    );
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'oom' });
    expect(r.stdout).not.toContain('ALLOCATED-4GB');
    expect(r.limits_hit).toContain('memory');
    const limit = 256 * 1024 * 1024;
    expect(r.usage.memory_peak_bytes).not.toBeNull();
    expect(r.usage.memory_peak_bytes ?? 0).toBeLessThanOrEqual(limit);
    expect(r.usage.memory_peak_bytes ?? 0).toBeGreaterThan(limit / 2);
    expect(r.hint).toContain('256 MB');

    // The host did not lose its memory (allow for unrelated drift).
    await new Promise((res) => setTimeout(res, 300));
    expect(before - memAvailableMb()).toBeLessThan(300);
  });
});
