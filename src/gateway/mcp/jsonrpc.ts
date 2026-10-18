// JSON-RPC 2.0 framing and parsing for the MCP stdio binding (prompt Stage 5 section 4.6): one
// message per line, UTF-8, no embedded newlines. Everything read here is untrusted input.

export type JsonRpcId = string | number;

export type Incoming =
  | {
      readonly kind: 'request';
      readonly id: JsonRpcId;
      readonly method: string;
      readonly params: unknown;
    }
  | { readonly kind: 'notification'; readonly method: string; readonly params: unknown }
  | {
      readonly kind: 'invalid';
      readonly id: JsonRpcId | null;
      readonly code: number;
      readonly message: string;
    };

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
/** MCP's UnsupportedProtocolVersionError. */
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** Longest line accepted. A longer one is discarded up to its newline and answered once. */
export const MAX_LINE_BYTES = 1024 * 1024;

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const decoder = new TextDecoder('utf-8', { fatal: true });

function isId(v: unknown): v is JsonRpcId {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

/** Parses one line. Never throws. */
export function parseMessage(line: string): Incoming {
  let raw: unknown;
  try {
    raw = JSON.parse(line, (key: string, value: unknown) => {
      if (FORBIDDEN.has(key)) throw new Error('forbidden key');
      return value;
    });
  } catch {
    return { kind: 'invalid', id: null, code: PARSE_ERROR, message: 'parse error' };
  }
  if (Array.isArray(raw)) {
    return {
      kind: 'invalid',
      id: null,
      code: INVALID_REQUEST,
      message: 'batches are not supported',
    };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'invalid', id: null, code: INVALID_REQUEST, message: 'not a JSON-RPC message' };
  }
  const obj = raw as Record<string, unknown>;
  const id = obj['id'];
  const hasId = 'id' in obj;
  const readableId = hasId && isId(id) ? id : null;
  if (obj['jsonrpc'] !== '2.0' || typeof obj['method'] !== 'string') {
    return {
      kind: 'invalid',
      id: readableId,
      code: INVALID_REQUEST,
      message: 'not a JSON-RPC 2.0 request or notification',
    };
  }
  if (hasId && !isId(id)) {
    return {
      kind: 'invalid',
      id: null,
      code: INVALID_REQUEST,
      message: 'the id must be a string or a number',
    };
  }
  if (hasId && isId(id)) {
    return { kind: 'request', id, method: obj['method'], params: obj['params'] };
  }
  return { kind: 'notification', method: obj['method'], params: obj['params'] };
}

export function resultMessage(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

export function errorMessage(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

export type FramerEvent =
  | { readonly kind: 'line'; readonly text: string }
  | { readonly kind: 'bad'; readonly reason: 'too_long' | 'bad_utf8' };

/**
 * Splits a byte stream into lines. A line over MAX_LINE_BYTES is dropped up to its newline (one
 * `bad` event), invalid UTF-8 is a `bad` event, and a trailing `\r` is tolerated.
 */
export class LineFramer {
  #chunks: Buffer[] = [];
  #size = 0;
  #discarding = false;

  push(chunk: Buffer): FramerEvent[] {
    const out: FramerEvent[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl < 0) {
        const rest = chunk.subarray(start);
        if (!this.#discarding) {
          this.#chunks.push(rest);
          this.#size += rest.length;
          if (this.#size > MAX_LINE_BYTES) {
            this.#chunks = [];
            this.#size = 0;
            this.#discarding = true;
            out.push({ kind: 'bad', reason: 'too_long' });
          }
        }
        return out;
      }
      const piece = chunk.subarray(start, nl);
      start = nl + 1;
      if (this.#discarding) {
        this.#discarding = false;
        continue;
      }
      const whole = this.#size === 0 ? piece : Buffer.concat([...this.#chunks, piece]);
      this.#chunks = [];
      this.#size = 0;
      if (whole.length > MAX_LINE_BYTES) {
        out.push({ kind: 'bad', reason: 'too_long' });
        continue;
      }
      const trimmed =
        whole.length > 0 && whole[whole.length - 1] === 0x0d ? whole.subarray(0, -1) : whole;
      if (trimmed.length === 0) continue;
      try {
        out.push({ kind: 'line', text: decoder.decode(trimmed) });
      } catch {
        out.push({ kind: 'bad', reason: 'bad_utf8' });
      }
    }
  }
}
