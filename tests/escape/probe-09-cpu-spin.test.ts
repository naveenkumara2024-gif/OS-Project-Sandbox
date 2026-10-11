import { describe, expect, it } from 'vitest';
import { helperBuilds, request, runIn } from '../helpers/cell.js';

// Probe 9: `while True: pass` for 60 s. Layer expected to stop it: the CPU budget measured from
// cgroup cpu.stat (the wall clock alone would take the full minute).
describe.each(helperBuilds())('probe 9: CPU spin ($name build)', (helper) => {
  it('is stopped by the CPU budget long before the wall clock', async () => {
    const t0 = Date.now();
    const r = await runIn(
      helper,
      request(['/usr/bin/python3', '-c', 'while True: pass'], {
        limits: { wall_ms: 60000, cpu_ms: 1500 },
      }),
    );
    const took = Date.now() - t0;
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'timeout', clock: 'cpu' });
    expect(r.limits_hit).toEqual(['cpu']);
    expect(r.usage.cpu_ms ?? 0).toBeGreaterThanOrEqual(1500);
    expect(r.usage.cpu_ms ?? 0).toBeLessThan(4000);
    expect(took).toBeLessThan(8000);
    expect(r.hint).toContain('1500 ms CPU budget');
  });

  it('is also bounded by the wall clock when the CPU budget is generous', async () => {
    const r = await runIn(
      helper,
      request(['/usr/bin/sleep', '30'], { limits: { wall_ms: 400, cpu_ms: 60000 } }),
    );
    expect(r.termination).toEqual({ cause: 'timeout', clock: 'wall' });
    expect(r.limits_hit).toEqual(['wall']);
  });
});
