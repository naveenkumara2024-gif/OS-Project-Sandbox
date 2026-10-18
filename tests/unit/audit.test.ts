import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  fileAuditSink,
  MAX_RECEIPT_ENTRIES,
  ROTATE_BYTES,
  type AuditEntry,
} from '../../src/broker/audit.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aegis-audit-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = (n: number): AuditEntry => ({
  ts: n,
  host: `h${String(n)}.example`,
  port: 443,
  decision: 'deny',
  reason: 'not_allowlisted',
  bytes_up: 0,
  bytes_down: 0,
  duration_ms: 1,
});

describe('AuditLog', () => {
  it('keeps at most 256 entries for the receipt and counts the rest', () => {
    const seen: number[] = [];
    const log = new AuditLog((e) => seen.push(e.ts));
    for (let i = 0; i < MAX_RECEIPT_ENTRIES + 44; i++) log.add(entry(i));
    expect(log.entries).toHaveLength(MAX_RECEIPT_ENTRIES);
    expect(log.dropped).toBe(44);
    // The file sink still saw every one.
    expect(seen).toHaveLength(MAX_RECEIPT_ENTRIES + 44);
  });
});

describe('fileAuditSink', () => {
  it('appends JSON lines (mode 0600) tagged with the run and manifest hash', () => {
    const file = join(dir, 'audit.jsonl');
    const sink = fileAuditSink(file, { run: 'r-1', manifest_sha256: 'ab'.repeat(32) });
    sink(entry(1));
    sink(entry(2));
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({
      run: 'r-1',
      manifest_sha256: 'ab'.repeat(32),
      host: 'h2.example',
      decision: 'deny',
    });
  });

  it('rotates once when the file passes 10 MiB', () => {
    const file = join(dir, 'audit.jsonl');
    writeFileSync(file, Buffer.alloc(ROTATE_BYTES + 1, 0x20));
    fileAuditSink(file, { run: 'r', manifest_sha256: 'x' })(entry(1));
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('never throws when the file cannot be written', () => {
    const sink = fileAuditSink(join(dir, 'no', 'such', 'dir', 'a.jsonl'), {
      run: 'r',
      manifest_sha256: 'x',
    });
    expect(() => {
      sink(entry(1));
    }).not.toThrow();
  });
});
