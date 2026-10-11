import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { helperBuilds, request, runIn } from '../helpers/cell.js';

// Probe 17: fill the disk with dd. Layer expected to stop it: the size-capped tmpfs mounts (the
// cell has no writable host filesystem), also bounded by the memory cgroup that tmpfs pages are
// charged to.
function freeBytes(path: string): number {
  const s = statfsSync(path);
  return s.bavail * s.bsize;
}

describe.each(helperBuilds())('probe 17: disk fill ($name build)', (helper) => {
  it('hits the cap, is classified disk_limit, and the host disk is unchanged', async () => {
    const hostBefore = freeBytes(tmpdir());
    const r = await runIn(
      helper,
      request(
        [
          '/usr/bin/sh',
          '-c',
          // Keep dd's exit status as the payload's, and report how much really landed.
          'dd if=/dev/zero of=/tmp/fill bs=1M; rc=$?; echo size=$(wc -c < /tmp/fill); exit $rc',
        ],
        {
          limits: { disk_mb: 8, wall_ms: 20000 },
        },
      ),
    );
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'disk_limit', path: '/tmp' });
    expect(r.exit_code).toBe(1);
    expect(r.stderr).toMatch(/No space left on device/);
    expect(r.limits_hit).toContain('disk');
    // How much really landed: about the cap, never more.
    const written = /size=(\d+)/.exec(r.stdout);
    expect(Number(written?.[1] ?? 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(Number(written?.[1] ?? 0)).toBeGreaterThan(4 * 1024 * 1024);

    // Nothing was written to the host: the temp directory's free space did not shrink.
    expect(hostBefore - freeBytes(tmpdir())).toBeLessThan(4 * 1024 * 1024);
  });

  it('leaves the host root filesystem alone when asked to write outside /tmp', async () => {
    const r = await runIn(
      helper,
      request(
        [
          '/usr/bin/sh',
          '-c',
          'echo x > /usr/FILL 2>&1; echo rc=$?; echo x > /home/FILL 2>&1; echo rc=$?',
        ],
        {},
      ),
    );
    // /usr is writable only because the plan created that directory on the cell's tmpfs root;
    // /home does not exist. Either way nothing reaches the host.
    expect(r.stdout).toMatch(/rc=[01]/);
    // A failed redirection is reported on the shell's own stderr, not on the command's.
    expect(r.stdout + r.stderr).toMatch(/Directory nonexistent|No such file or directory/);
  });
});
