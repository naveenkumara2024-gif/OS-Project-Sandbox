import { isIP } from 'node:net';

// The broker's only protocol: HTTP `CONNECT host:port HTTP/1.1` (prompt Stage 5 section 4.7). The
// parser is strict and bounded. It decides from the text it was given and nothing else, and it
// refuses anything that could mean two things to two parsers.

export const MAX_REQUEST_LINE = 512;
export const MAX_HEAD_BYTES = 8 * 1024;
export const MAX_HEADERS = 32;

export type ConnectRequest =
  | { readonly ok: true; readonly host: string; readonly port: number; readonly consumed: number }
  | { readonly ok: false; readonly reason: 'bad_request' | 'bad_method' };

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);
const HEADER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}:[\t -~]{0,2048}$/;

/** Index just past the end of the header block (`\r\n\r\n`), or -1 if it has not all arrived. */
export function headEnd(buf: Buffer): number {
  const i = buf.indexOf('\r\n\r\n');
  return i < 0 ? -1 : i + 4;
}

/**
 * A normalised hostname, or null. Lower-cased, one trailing dot removed, ASCII letters, digits
 * and hyphens only. IP literals in any spelling (dotted, short, decimal, hex, octal, bracketed
 * IPv6) are refused: the broker takes names, and the allowlist is a list of names.
 */
export function normaliseHost(raw: string): string | null {
  let h = raw.toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!HOSTNAME.test(h)) return null;
  if (isIP(h) !== 0) return null;
  const labels = h.split('.');
  const last = labels[labels.length - 1] ?? '';
  // "ends in a number": 127.1, 2130706433, 0x7f.1 are all spellings of an address, not a name
  if (/^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return null;
  return h;
}

/** Parses the request head (everything up to and including the blank line). */
export function parseConnect(buf: Buffer): ConnectRequest {
  const end = headEnd(buf);
  if (end < 0 || end > MAX_HEAD_BYTES) return { ok: false, reason: 'bad_request' };
  const head = buf.subarray(0, end);
  // Only printable ASCII, tab, CR and LF: no NUL, no 8-bit text, no bare CR.
  for (const b of head) {
    if (!(b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e))) {
      return { ok: false, reason: 'bad_request' };
    }
  }
  const text = head.toString('latin1').slice(0, -4);
  if (/\r(?!\n)|(?<!\r)\n/.test(text)) return { ok: false, reason: 'bad_request' };
  const lines = text.split('\r\n');
  const requestLine = lines[0] ?? '';
  if (requestLine.length > MAX_REQUEST_LINE) return { ok: false, reason: 'bad_request' };
  const m = /^([A-Za-z]+) (\S+) (HTTP\/1\.[01])$/.exec(requestLine);
  if (m === null) return { ok: false, reason: 'bad_request' };
  if (m[1] !== 'CONNECT') return { ok: false, reason: 'bad_method' };
  const headers = lines.slice(1);
  if (headers.length > MAX_HEADERS) return { ok: false, reason: 'bad_request' };
  for (const h of headers) {
    // No obsolete line folding, no headers that are not "name: value".
    if (!HEADER.test(h)) return { ok: false, reason: 'bad_request' };
  }
  // A request body or a second request riding on a CONNECT is smuggling.
  const lower = headers.map((h) => h.toLowerCase());
  if (lower.some((h) => h.startsWith('content-length:') && !/^content-length:\s*0\s*$/.test(h))) {
    return { ok: false, reason: 'bad_request' };
  }
  if (lower.some((h) => h.startsWith('transfer-encoding:')))
    return { ok: false, reason: 'bad_request' };

  const authority = m[2] ?? '';
  if (/[@\[\]%\\/?#]/.test(authority)) return { ok: false, reason: 'bad_request' };
  const colon = authority.lastIndexOf(':');
  if (colon <= 0 || colon === authority.length - 1) return { ok: false, reason: 'bad_request' };
  const host = normaliseHost(authority.slice(0, colon));
  const portText = authority.slice(colon + 1);
  if (host === null || !/^[1-9][0-9]{0,4}$/.test(portText))
    return { ok: false, reason: 'bad_request' };
  const port = Number(portText);
  if (port > 65535) return { ok: false, reason: 'bad_request' };
  return { ok: true, host, port, consumed: end };
}
