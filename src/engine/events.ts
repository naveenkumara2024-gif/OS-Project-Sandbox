import { StringDecoder } from 'node:string_decoder';
import type { CellResult } from '../launch/run-cell.js';

// Run events (prompt Stage 5 section 4.3). Events are a convenience for a caller that wants to
// watch a run; the final receipt still carries the full bounded output, so a dropped chunk never
// loses information. Every queue here is bounded, and a slow reader can lose output chunks but can
// never slow the cell down or lose the receipt.

export type LimitName = 'wall' | 'cpu' | 'memory' | 'output' | 'disk' | 'pids';

/** What the cell supervision code can emit. */
export type CellEvent =
  | { readonly type: 'started' }
  | { readonly type: 'stdout' | 'stderr'; readonly data: string }
  | {
      readonly type: 'limit_warning';
      readonly limit: LimitName;
      readonly used: number;
      readonly max: number;
    };

/** Everything a run can emit: the cell's events plus the engine's own. */
export type EventBody =
  | CellEvent
  | { readonly type: 'queued'; readonly position: number }
  | { readonly type: 'receipt'; readonly receipt: CellResult }
  /** The run ended without a receipt (refused before it started, or cancelled while queued). */
  | { readonly type: 'failed'; readonly code: string };

export type RunEvent = EventBody & {
  /** Monotonic per run, starting at 1. */
  readonly seq: number;
  /** Milliseconds since the run was created. */
  readonly t_ms: number;
  /** Bytes of output chunks this reader lost just before this event (slow reader only). */
  readonly dropped?: number;
};

export const HISTORY_BYTES = 1024 * 1024;
export const SUBSCRIBER_BYTES = 256 * 1024;
export const MAX_CHUNK_BYTES = 8 * 1024;
export const COALESCE_MS = 50;

const sizeOf = (e: RunEvent): number => JSON.stringify(e).length;
const isOutput = (e: EventBody): e is Extract<EventBody, { type: 'stdout' | 'stderr' }> =>
  e.type === 'stdout' || e.type === 'stderr';

class Subscriber {
  readonly queue: RunEvent[] = [];
  queuedBytes = 0;
  dropped = 0;
  closed = false;
  wake: (() => void) | null = null;
}

export class RunEvents {
  readonly #history: RunEvent[] = [];
  #historyBytes = 0;
  readonly #subs = new Set<Subscriber>();
  readonly #started: number;
  readonly #now: () => number;
  #seq = 0;
  #finished = false;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
    this.#started = now();
  }

  get finished(): boolean {
    return this.#finished;
  }

  push(body: EventBody): void {
    if (this.#finished) return;
    const event: RunEvent = {
      ...body,
      seq: ++this.#seq,
      t_ms: Math.round(this.#now() - this.#started),
    };
    const size = sizeOf(event);
    // History keeps every control event, and output chunks only while there is room.
    if (!isOutput(body) || this.#historyBytes + size <= HISTORY_BYTES) {
      this.#history.push(event);
      this.#historyBytes += size;
    }
    for (const sub of this.#subs) this.#deliver(sub, event, size);
  }

  #deliver(sub: Subscriber, event: RunEvent, size: number): void {
    if (sub.closed) return;
    if (isOutput(event) && sub.queuedBytes + size > SUBSCRIBER_BYTES) {
      sub.dropped += event.data.length;
      return;
    }
    const out: RunEvent =
      isOutput(event) && sub.dropped > 0 ? { ...event, dropped: sub.dropped } : event;
    if (isOutput(event)) sub.dropped = 0;
    sub.queue.push(out);
    sub.queuedBytes += size;
    sub.wake?.();
  }

  /** Ends the stream: readers get what is queued and then finish. */
  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    for (const sub of this.#subs) sub.wake?.();
  }

  /** Replays the history and then follows live events until the run finishes. */
  subscribe(): AsyncIterable<RunEvent> {
    const sub = new Subscriber();
    for (const e of this.#history) {
      // The history was already bounded as a whole; replay respects the subscriber bound too.
      this.#deliver(sub, e, sizeOf(e));
    }
    this.#subs.add(sub);
    const subs = this.#subs;
    const finished = (): boolean => this.#finished;
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<RunEvent> => ({
        async next(): Promise<IteratorResult<RunEvent>> {
          for (;;) {
            const e = sub.queue.shift();
            if (e !== undefined) {
              sub.queuedBytes -= sizeOf(e);
              return { value: e, done: false };
            }
            if (sub.closed || finished()) {
              subs.delete(sub);
              return { value: undefined, done: true };
            }
            await new Promise<void>((resolve) => {
              sub.wake = resolve;
            });
            sub.wake = null;
          }
        },
        return(): Promise<IteratorResult<RunEvent>> {
          sub.closed = true;
          subs.delete(sub);
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    };
  }
}

/**
 * Turns raw output bytes into `stdout` / `stderr` events: at most MAX_CHUNK_BYTES each, coalesced
 * for COALESCE_MS, decoded as UTF-8 without splitting a character across two events.
 */
export class OutputCoalescer {
  readonly #emit: (e: CellEvent) => void;
  readonly #state = {
    stdout: { decoder: new StringDecoder('utf8'), text: '', timer: null as NodeJS.Timeout | null },
    stderr: { decoder: new StringDecoder('utf8'), text: '', timer: null as NodeJS.Timeout | null },
  };

  constructor(emit: (e: CellEvent) => void) {
    this.#emit = emit;
  }

  write(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const s = this.#state[stream];
    s.text += s.decoder.write(chunk);
    while (s.text.length >= MAX_CHUNK_BYTES) {
      this.#emit({ type: stream, data: s.text.slice(0, MAX_CHUNK_BYTES) });
      s.text = s.text.slice(MAX_CHUNK_BYTES);
    }
    if (s.text !== '' && s.timer === null) {
      s.timer = setTimeout(() => {
        this.#flush(stream);
      }, COALESCE_MS);
    }
  }

  #flush(stream: 'stdout' | 'stderr'): void {
    const s = this.#state[stream];
    if (s.timer !== null) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    if (s.text !== '') {
      this.#emit({ type: stream, data: s.text });
      s.text = '';
    }
  }

  /** Emits whatever is pending (call when the run ends, before the receipt). */
  end(): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const s = this.#state[stream];
      s.text += s.decoder.end();
      this.#flush(stream);
    }
  }
}
