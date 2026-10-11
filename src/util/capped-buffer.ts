/** Accumulates chunks up to a hard cap; excess bytes are dropped, never buffered (CLAUDE.md 5.1). */
export class CappedBuffer {
  readonly #max: number;
  readonly #chunks: Buffer[] = [];
  #size = 0;
  #overflowed = false;

  constructor(max: number) {
    this.#max = max;
  }

  /** Returns false once the cap has been exceeded. */
  push(chunk: Buffer): boolean {
    if (this.#overflowed) {
      return false;
    }
    const room = this.#max - this.#size;
    if (chunk.length > room) {
      if (room > 0) {
        this.#chunks.push(chunk.subarray(0, room));
        this.#size += room;
      }
      this.#overflowed = true;
      return false;
    }
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    return true;
  }

  get overflowed(): boolean {
    return this.#overflowed;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.#chunks, this.#size);
  }
}
