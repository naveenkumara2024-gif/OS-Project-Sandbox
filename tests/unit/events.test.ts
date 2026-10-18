import { describe, expect, it } from 'vitest';
import {
  COALESCE_MS,
  HISTORY_BYTES,
  MAX_CHUNK_BYTES,
  OutputCoalescer,
  RunEvents,
  SUBSCRIBER_BYTES,
  type CellEvent,
  type RunEvent,
} from '../../src/engine/events.js';
import type { CellResult } from '../../src/launch/run-cell.js';

const receipt = { id: 'r' } as unknown as CellResult;

async function collect(it: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('RunEvents', () => {
  it('numbers events from 1, stamps time, and replays history to a late subscriber', async () => {
    let t = 0;
    const ev = new RunEvents(() => (t += 10));
    ev.push({ type: 'started' });
    ev.push({ type: 'stdout', data: 'hi' });
    ev.push({ type: 'receipt', receipt });
    ev.finish();
    const got = await collect(ev.subscribe());
    expect(got.map((e) => [e.seq, e.type])).toEqual([
      [1, 'started'],
      [2, 'stdout'],
      [3, 'receipt'],
    ]);
    expect(got[1]?.t_ms).toBeGreaterThan(got[0]?.t_ms ?? 0);
  });

  it('delivers live events to a waiting subscriber and ends when the run finishes', async () => {
    const ev = new RunEvents();
    const reading = collect(ev.subscribe());
    await new Promise((r) => setTimeout(r, 10));
    ev.push({ type: 'started' });
    ev.push({ type: 'stderr', data: 'x' });
    ev.push({ type: 'receipt', receipt });
    ev.finish();
    expect((await reading).map((e) => e.type)).toEqual(['started', 'stderr', 'receipt']);
  });

  it('a slow reader loses output chunks, is told how much, and still gets the receipt', async () => {
    const ev = new RunEvents();
    const sub = ev.subscribe()[Symbol.asyncIterator]();
    const chunk = 'x'.repeat(MAX_CHUNK_BYTES);
    const n = Math.ceil(SUBSCRIBER_BYTES / chunk.length) * 3;
    ev.push({ type: 'started' });
    for (let i = 0; i < n; i++) ev.push({ type: 'stdout', data: chunk });
    // Drain a little, then push one more chunk: it carries the dropped count.
    const first = await sub.next();
    expect(first.done).toBe(false);
    if (first.done !== true) expect(first.value.type).toBe('started');
    for (let i = 0; i < 20; i++) await sub.next();
    ev.push({ type: 'stdout', data: 'late' });
    ev.push({ type: 'receipt', receipt });
    ev.finish();
    const rest: RunEvent[] = [];
    for (;;) {
      const r = await sub.next();
      if (r.done === true) break;
      rest.push(r.value);
    }
    expect(rest[rest.length - 1]?.type).toBe('receipt');
    const dropped = rest.find((e) => 'dropped' in e && (e.dropped ?? 0) > 0);
    expect(dropped).toBeDefined();
    expect(rest.filter((e) => e.type === 'receipt')).toHaveLength(1);
  });

  it('keeps control events in history even when output has used the history budget', async () => {
    const ev = new RunEvents();
    const chunk = 'y'.repeat(MAX_CHUNK_BYTES);
    for (let i = 0; i < (HISTORY_BYTES / chunk.length) * 2; i++)
      ev.push({ type: 'stdout', data: chunk });
    ev.push({ type: 'receipt', receipt });
    ev.finish();
    const got = await collect(ev.subscribe());
    expect(got[got.length - 1]?.type).toBe('receipt');
    expect(got.length).toBeLessThan((HISTORY_BYTES / chunk.length) * 2);
  });

  it('ignores events pushed after finish, and a returned iterator stops cleanly', async () => {
    const ev = new RunEvents();
    const it = ev.subscribe()[Symbol.asyncIterator]();
    await it.return?.();
    ev.push({ type: 'started' });
    ev.finish();
    ev.push({ type: 'stdout', data: 'too late' });
    expect((await collect(ev.subscribe())).map((e) => e.type)).toEqual(['started']);
  });
});

describe('OutputCoalescer', () => {
  it('coalesces small writes into one event after the interval', async () => {
    const got: CellEvent[] = [];
    const c = new OutputCoalescer((e) => got.push(e));
    c.write('stdout', Buffer.from('a'));
    c.write('stdout', Buffer.from('b'));
    c.write('stderr', Buffer.from('e'));
    expect(got).toHaveLength(0);
    await new Promise((r) => setTimeout(r, COALESCE_MS + 60));
    expect(got).toEqual([
      { type: 'stdout', data: 'ab' },
      { type: 'stderr', data: 'e' },
    ]);
  });

  it('splits large writes at the chunk size and does not split a multi-byte character', () => {
    const got: CellEvent[] = [];
    const c = new OutputCoalescer((e) => got.push(e));
    const euro = Buffer.from('€'); // 3 bytes
    c.write('stdout', euro.subarray(0, 1));
    c.write('stdout', euro.subarray(1));
    c.write('stdout', Buffer.from('z'.repeat(MAX_CHUNK_BYTES + 5)));
    c.end();
    const text = got.map((e) => (e.type === 'stdout' ? e.data : '')).join('');
    expect(text).toBe(`€${'z'.repeat(MAX_CHUNK_BYTES + 5)}`);
    for (const e of got) {
      if (e.type === 'stdout') expect(e.data.length).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    }
  });

  it('end() flushes what is pending, including a dangling partial character', () => {
    const got: CellEvent[] = [];
    const c = new OutputCoalescer((e) => got.push(e));
    c.write('stderr', Buffer.from([0xe2, 0x82])); // half of a euro sign
    c.end();
    expect(got).toHaveLength(1);
    expect(got[0]?.type).toBe('stderr');
  });
});
