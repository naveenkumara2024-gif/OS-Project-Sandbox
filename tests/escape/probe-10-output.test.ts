import { describe, expect, it } from 'vitest';
import { RECEIPT_LAYERS } from '../../src/probe/isolation.js';
import { helperBuilds, request, runIn } from '../helpers/cell.js';

// Probe 10: endless output. Layer expected to stop it: the bounded output readers.
describe.each(helperBuilds())('probe 10: endless output ($name build)', (helper) => {
  it('is cut at the cap and still returns a complete receipt', async () => {
    const r = await runIn(helper, request(['/usr/bin/yes'], { limits: { output_kb: 64 } }));
    expect(r.termination).toEqual({ cause: 'output_limit', stream: 'stdout' });
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(64 * 1024);
    expect(r.limits_hit).toEqual(['output']);
    expect(r.hint).toContain('64 KB');
    expect(r.isolation.level).toBe(2);
    for (const l of RECEIPT_LAYERS) expect(r.isolation.layers[l], l).toBe(true);
    expect(r.usage.wall_ms).toBeGreaterThan(0);
  });
});
