import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  emptyReceiptLayers,
  isolationLevel,
  RECEIPT_LAYERS,
  TIERS,
  type ReceiptLayer,
} from '../../src/probe/isolation.js';

function all(value: boolean): Record<ReceiptLayer, boolean> {
  const o = emptyReceiptLayers();
  for (const l of RECEIPT_LAYERS) o[l] = value;
  return o;
}

describe('isolationLevel', () => {
  it('is 0 with nothing and the number of tiers with everything', () => {
    expect(isolationLevel(all(false))).toBe(0);
    expect(isolationLevel(all(true))).toBe(TIERS.length);
  });

  it('counts consecutive tiers only', () => {
    const l = all(true);
    l.userns = false; // tier 1 broken: nothing above it counts
    expect(isolationLevel(l)).toBe(0);
    const m = all(true);
    m.cgroup_memory = false; // tier 2 broken
    expect(isolationLevel(m)).toBe(1);
  });

  it('does not depend on the optional layers', () => {
    const l = all(true);
    l.cgroup_cpu = false;
    l.cgroup_kill = false;
    expect(isolationLevel(l)).toBe(TIERS.length);
  });

  it('is monotone: turning a layer off never raises the level', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), {
          minLength: RECEIPT_LAYERS.length,
          maxLength: RECEIPT_LAYERS.length,
        }),
        fc.nat(RECEIPT_LAYERS.length - 1),
        (bits, i) => {
          const before = emptyReceiptLayers();
          RECEIPT_LAYERS.forEach((l, j) => {
            before[l] = bits[j] ?? false;
          });
          const after = { ...before };
          const name = RECEIPT_LAYERS[i];
          if (name !== undefined) after[name] = false;
          expect(isolationLevel(after)).toBeLessThanOrEqual(isolationLevel(before));
        },
      ),
      { numRuns: 300 },
    );
  });
});
