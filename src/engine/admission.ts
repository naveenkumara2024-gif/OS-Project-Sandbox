import { err, ok, type Result } from '../util/result.js';

// Admission control (prompt Stage 5 section 4.3): at most `maxCells` cells at once and at most
// `memoryBudgetMb` of memory limits added up. A run that does not fit waits in a bounded FIFO queue
// for a bounded time and is then refused. Only the head of the queue may start, so a large run
// cannot be starved by a stream of small ones.

export const MAX_QUEUE = 16;
export const DEFAULT_WAIT_MS = 30_000;

interface Waiter {
  readonly memoryMb: number;
  readonly resolve: (r: Result<() => void>) => void;
  readonly onPosition: ((position: number) => void) | undefined;
  timer: NodeJS.Timeout | null;
  abort: (() => void) | null;
}

export interface AdmissionStats {
  readonly running: number;
  readonly queued: number;
  readonly memoryInUseMb: number;
}

export class Admission {
  readonly #maxCells: number;
  readonly #budgetMb: number;
  readonly #queue: Waiter[] = [];
  #running = 0;
  #memoryMb = 0;

  constructor(maxCells: number, memoryBudgetMb: number) {
    this.#maxCells = maxCells;
    this.#budgetMb = memoryBudgetMb;
  }

  stats(): AdmissionStats {
    return { running: this.#running, queued: this.#queue.length, memoryInUseMb: this.#memoryMb };
  }

  #fits(memoryMb: number): boolean {
    return this.#running < this.#maxCells && this.#memoryMb + memoryMb <= this.#budgetMb;
  }

  #start(memoryMb: number): () => void {
    this.#running += 1;
    this.#memoryMb += memoryMb;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#running -= 1;
      this.#memoryMb -= memoryMb;
      this.#drain();
    };
  }

  #drain(): void {
    for (;;) {
      const head = this.#queue[0];
      if (head === undefined || !this.#fits(head.memoryMb)) break;
      this.#queue.shift();
      this.#settle(head, ok(this.#start(head.memoryMb)));
    }
    this.#queue.forEach((w, i) => w.onPosition?.(i + 1));
  }

  #settle(w: Waiter, r: Result<() => void>): void {
    if (w.timer !== null) clearTimeout(w.timer);
    w.abort?.();
    w.resolve(r);
  }

  /**
   * Resolves with a release function once the run may start. Errors: `E2BIG` if it can never fit,
   * `EBUSY` if the queue is full or the wait expired, `ECANCELED` if `signal` aborted first.
   */
  acquire(
    memoryMb: number,
    opts: {
      readonly signal?: AbortSignal;
      readonly waitMs?: number;
      readonly onPosition?: (position: number) => void;
    } = {},
  ): Promise<Result<() => void>> {
    if (memoryMb > this.#budgetMb) {
      return Promise.resolve(err('E2BIG', 'the run asks for more memory than the whole budget'));
    }
    if (opts.signal?.aborted === true) {
      return Promise.resolve(err('ECANCELED', 'cancelled before it started'));
    }
    if (this.#queue.length === 0 && this.#fits(memoryMb)) {
      return Promise.resolve(ok(this.#start(memoryMb)));
    }
    if (this.#queue.length >= MAX_QUEUE) {
      return Promise.resolve(err('EBUSY', 'too many runs are waiting'));
    }
    return new Promise((resolve) => {
      const w: Waiter = {
        memoryMb,
        resolve,
        onPosition: opts.onPosition,
        timer: null,
        abort: null,
      };
      w.timer = setTimeout(() => {
        this.#remove(w);
        resolve(err('EBUSY', 'no capacity became free in time'));
      }, opts.waitMs ?? DEFAULT_WAIT_MS);
      if (opts.signal !== undefined) {
        const onAbort = (): void => {
          this.#remove(w);
          if (w.timer !== null) clearTimeout(w.timer);
          resolve(err('ECANCELED', 'cancelled while waiting'));
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
        w.abort = () => {
          opts.signal?.removeEventListener('abort', onAbort);
        };
      }
      this.#queue.push(w);
      opts.onPosition?.(this.#queue.length);
    });
  }

  #remove(w: Waiter): void {
    const i = this.#queue.indexOf(w);
    if (i >= 0) this.#queue.splice(i, 1);
    w.abort?.();
    this.#queue.forEach((x, j) => x.onPosition?.(j + 1));
  }
}
