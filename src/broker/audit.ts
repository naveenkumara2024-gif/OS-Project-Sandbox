import { appendFileSync, renameSync, statSync } from 'node:fs';

// The egress audit log (prompt Stage 5 section 4.7): one entry per attempt, allowed or denied.
// The receipt carries a bounded copy; the same entries are appended to a host file. Payload bytes
// are never recorded, only hostnames, ports, decisions, reasons and byte counts.

export type AuditReason =
  | 'ok'
  | 'not_allowlisted'
  | 'port_not_allowed'
  | 'bad_request'
  | 'bad_method'
  | 'private_address'
  | 'resolve_failed'
  | 'connect_failed'
  | 'limit';

export interface AuditEntry {
  readonly ts: number;
  readonly host: string;
  readonly port: number;
  readonly decision: 'allow' | 'deny';
  readonly reason: AuditReason;
  /** The single address that was connected to (allowed entries only). */
  readonly resolved?: string;
  readonly bytes_up: number;
  readonly bytes_down: number;
  readonly duration_ms: number;
}

export const MAX_RECEIPT_ENTRIES = 256;
export const ROTATE_BYTES = 10 * 1024 * 1024;

export class AuditLog {
  readonly #entries: AuditEntry[] = [];
  #dropped = 0;
  readonly #sink: ((e: AuditEntry) => void) | null;

  constructor(sink: ((e: AuditEntry) => void) | null = null) {
    this.#sink = sink;
  }

  add(e: AuditEntry): void {
    if (this.#entries.length < MAX_RECEIPT_ENTRIES) this.#entries.push(e);
    else this.#dropped += 1;
    this.#sink?.(e);
  }

  get entries(): readonly AuditEntry[] {
    return this.#entries;
  }

  get dropped(): number {
    return this.#dropped;
  }
}

/**
 * A sink that appends JSON lines to `file` (created 0600), rotating it once at ROTATE_BYTES. Each
 * line carries the run id and manifest hash so it can be matched to a receipt.
 */
export function fileAuditSink(
  file: string,
  context: { readonly run: string; readonly manifest_sha256: string },
): (e: AuditEntry) => void {
  return (e) => {
    try {
      try {
        if (statSync(file).size > ROTATE_BYTES) renameSync(file, `${file}.1`);
      } catch {
        // No file yet.
      }
      appendFileSync(file, `${JSON.stringify({ ...context, ...e })}\n`, { mode: 0o600 });
    } catch {
      // The audit file is a copy; the receipt still has the entry. A failure here must not
      // change what the broker decides.
    }
  };
}
