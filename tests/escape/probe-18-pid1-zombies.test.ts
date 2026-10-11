import { mkdtempSync, readdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { helperBuilds, request, runIn, sh } from '../helpers/cell.js';

// Probe 18: ignore SIGTERM as PID 1 and leave zombies. Layer expected to stop it: aegis-cell init
// (PID 1 reaps and forwards) and cgroup.kill (a payload that ignores every polite signal is
// ended anyway, with nothing left behind).
describe.each(helperBuilds())('probe 18: PID 1 and zombies ($name build)', (helper) => {
  it('is ended by the supervisor even though it ignores TERM and INT', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'aegis-p18-'));
    const t0 = Date.now();
    const r = await sh(
      helper,
      [
        "trap '' TERM INT HUP",
        '(sleep 0.05; exit 0) &',
        "sh -c 'sleep 0.1 & sleep 0.1 & exit 0' &",
        'kill -TERM $$; echo still-here',
        'sleep 60',
      ].join('; '),
      { limits: { wall_ms: 700 } },
      parent,
    );
    const took = Date.now() - t0;
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'timeout', clock: 'wall' });
    expect(r.stdout).toContain('still-here'); // the payload really did ignore SIGTERM
    expect(took).toBeLessThan(5000);
    // Nothing is left: the per-cell directory is gone and the engine's cgroup list has no cell.
    expect(readdirSync(parent)).toEqual([]);
    rmdirSync(parent);
  });

  it('never lets a zombie accumulate while the payload keeps spawning short-lived children', async () => {
    const r = await runIn(
      helper,
      request(
        [
          '/usr/bin/sh',
          '-c',
          'i=0; while [ $i -lt 150 ]; do (sleep 0.001 &) ; i=$((i+1)); done; sleep 0.5; ' +
            "cat /proc/[0-9]*/stat | cut -d' ' -f3 | grep -c Z",
        ],
        { limits: { wall_ms: 15000 } },
      ),
    );
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    expect(r.stdout.trim()).toBe('0'); // grep -c prints 0 and exits 1 when there is none
  });
});
