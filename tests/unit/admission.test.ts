import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Admission, MAX_QUEUE } from '../../src/engine/admission.js';

describe('Admission', () => {
  it('admits up to maxCells at once and queues the rest in order', async () => {
    const a = new Admission(2, 10_000);
    const r1 = await a.acquire(100);
    const r2 = await a.acquire(100);
    expect(r1.ok && r2.ok).toBe(true);
    const order: number[] = [];
    const p3 = a.acquire(100).then((r) => {
      order.push(3);
      return r;
    });
    const p4 = a.acquire(100).then((r) => {
      order.push(4);
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(a.stats()).toMatchObject({ running: 2, queued: 2 });
    if (r1.ok) r1.value();
    const third = await p3;
    expect(third.ok).toBe(true);
    if (r2.ok) r2.value();
    const fourth = await p4;
    expect(fourth.ok).toBe(true);
    expect(order).toEqual([3, 4]);
  });

  it('never lets the memory limits add up past the budget', async () => {
    const a = new Admission(10, 1000);
    const big = await a.acquire(800);
    expect(big.ok).toBe(true);
    const waiting = a.acquire(300, { waitMs: 60 });
    const r = await waiting;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('EBUSY');
    if (big.ok) big.value();
    const small = await a.acquire(300);
    expect(small.ok).toBe(true);
  });

  it('refuses at once a run that can never fit', async () => {
    const r = await new Admission(4, 512).acquire(513);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E2BIG');
  });

  it('does not let a small run overtake a large one at the head of the queue', async () => {
    const a = new Admission(4, 1000);
    const hold = await a.acquire(900);
    const order: string[] = [];
    const large = a.acquire(800, { waitMs: 2000 }).then((r) => {
      order.push('large');
      return r;
    });
    const small = a.acquire(50, { waitMs: 2000 }).then((r) => {
      order.push('small');
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    if (hold.ok) hold.value();
    const [l, s] = await Promise.all([large, small]);
    expect(l.ok && s.ok).toBe(true);
    expect(order).toEqual(['large', 'small']);
  });

  it('refuses when the queue is full, and a cancelled waiter leaves the queue', async () => {
    const a = new Admission(1, 1000);
    const hold = await a.acquire(10);
    const ctrl = new AbortController();
    const waiters = Array.from({ length: MAX_QUEUE }, (_, i) =>
      a.acquire(10, i === 0 ? { signal: ctrl.signal, waitMs: 5000 } : { waitMs: 5000 }),
    );
    const overflow = await a.acquire(10);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error.code).toBe('EBUSY');
    ctrl.abort();
    const cancelled = await waiters[0];
    expect(cancelled?.ok).toBe(false);
    if (cancelled && !cancelled.ok) expect(cancelled.error.code).toBe('ECANCELED');
    expect(a.stats().queued).toBe(MAX_QUEUE - 1);
    if (hold.ok) hold.value();
    // drain the rest so no timers linger
    for (let i = 1; i < waiters.length; i++) {
      const r = await waiters[i];
      if (r?.ok) r.value();
    }
  });

  it('a pre-aborted signal is refused immediately; release is idempotent', async () => {
    const a = new Admission(1, 100);
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await a.acquire(10, { signal: ctrl.signal });
    expect(r.ok).toBe(false);
    const ok1 = await a.acquire(10);
    if (ok1.ok) {
      ok1.value();
      ok1.value();
    }
    expect(a.stats()).toEqual({ running: 0, queued: 0, memoryInUseMb: 0 });
  });

  it('property: concurrent holders never exceed the cell or memory limits', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.integer({ min: 1, max: 400 }), { minLength: 1, maxLength: 10 }),
        async (maxCells, sizes) => {
          const a = new Admission(maxCells, 800);
          let peakRunning = 0;
          let peakMem = 0;
          await Promise.all(
            sizes.map(async (mb) => {
              const r = await a.acquire(mb, { waitMs: 5000 });
              if (!r.ok) return;
              const s = a.stats();
              peakRunning = Math.max(peakRunning, s.running);
              peakMem = Math.max(peakMem, s.memoryInUseMb);
              await new Promise((res) => setTimeout(res, 1));
              r.value();
            }),
          );
          expect(peakRunning).toBeLessThanOrEqual(maxCells);
          expect(peakMem).toBeLessThanOrEqual(800);
        },
      ),
      { numRuns: 30 },
    );
  });
});
