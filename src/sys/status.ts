import { err, ok, type Result } from '../util/result.js';

/** Layer names the helper may report (native/src/boot.c). The first eleven are the receipt layers. */
export const RECEIPT_LAYERS = [
  'userns',
  'pidns',
  'mountns',
  'netns',
  'ipcns',
  'utsns',
  'cgroupns',
  'timens',
  'root',
  'proc',
  'dev',
] as const;

export type ReceiptLayer = (typeof RECEIPT_LAYERS)[number];

/** Pseudo-layers that only ever appear in a failure record. */
const FAILURE_ONLY = ['spec', 'namespaces', 'idmap', 'exec'] as const;
const KNOWN_LAYERS = new Set<string>([...RECEIPT_LAYERS, ...FAILURE_ONLY]);

export type StatusRecord =
  | { readonly kind: 'layer'; readonly layer: string; readonly ok: true }
  | { readonly kind: 'layer'; readonly layer: string; readonly ok: false; readonly errno: number }
  | { readonly kind: 'started'; readonly pid: number }
  | { readonly kind: 'exited'; readonly code: number }
  | { readonly kind: 'signaled'; readonly signal: number };

const MAX_RECORDS = 256;

function parseDecimal(s: string | undefined): number | null {
  if (s === undefined || !/^[0-9]{1,10}$/.test(s)) {
    return null;
  }
  return Number(s);
}

/**
 * Strict parser for the helper's status stream. Anything unrecognised is an error, never skipped:
 * a protocol surprise must not be mistaken for a clean run (CLAUDE.md 5.3).
 */
export function parseStatus(text: string): Result<StatusRecord[]> {
  const out: StatusRecord[] = [];
  if (text === '') {
    return ok(out);
  }
  if (!text.endsWith('\n')) {
    return err('EPROTO', 'status stream ends mid-record');
  }
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > MAX_RECORDS) {
    return err('EPROTO', 'status stream has too many records');
  }
  for (const line of lines) {
    const f = line.split(' ');
    const head = f[0];
    if (head === 'layer' && f.length >= 3) {
      const layer = f[1];
      if (layer === undefined || !KNOWN_LAYERS.has(layer)) {
        return err('EPROTO', 'unknown layer in status record');
      }
      if (f.length === 3 && f[2] === 'ok') {
        out.push({ kind: 'layer', layer, ok: true });
        continue;
      }
      const errno = parseDecimal(f[3]);
      if (f.length === 4 && f[2] === 'fail' && errno !== null) {
        out.push({ kind: 'layer', layer, ok: false, errno });
        continue;
      }
    } else if (f.length === 2) {
      const n = parseDecimal(f[1]);
      if (n !== null && head === 'started') {
        out.push({ kind: 'started', pid: n });
        continue;
      }
      if (n !== null && head === 'exited') {
        out.push({ kind: 'exited', code: n });
        continue;
      }
      if (n !== null && head === 'signaled') {
        out.push({ kind: 'signaled', signal: n });
        continue;
      }
    }
    return err('EPROTO', 'malformed status record');
  }
  return ok(out);
}
