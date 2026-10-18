import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { err, errFromException, ok, type Result } from '../util/result.js';
import type { IngestPolicy } from '../stage/ingest.js';
import type { CommitPolicy } from '../collect/commit.js';
import { MAX_POLICY_BYTES, parsePolicyFile, type Ceiling } from './ceiling.js';

// The human-owned policy file (CLAUDE.md 6.4): ingest and commit roots (Stage 3) and the ceiling
// (Stage 4). It is read once per command, hashed as read, and never mounted into a cell.

export interface Policy extends IngestPolicy, CommitPolicy {
  readonly ceiling: Ceiling;
  /** SHA-256 of the file bytes exactly as read; echoed in every receipt. */
  readonly ceilingSha256: string;
}

/** A policy that cannot be read or does not validate is an error, never a default. */
export function loadPolicy(path: string): Result<Policy> {
  let bytes: Buffer;
  try {
    if (statSync(path).size > MAX_POLICY_BYTES) {
      return err('E2BIG', 'policy file exceeds the byte limit');
    }
    bytes = readFileSync(path);
  } catch (e) {
    return errFromException(e, `read policy ${path}`);
  }
  const parsed = parsePolicyFile(bytes);
  if (!parsed.ok) {
    return parsed;
  }
  return ok({
    ingestRoots: parsed.value.ingestRoots,
    ingestExcludes: parsed.value.ingestExcludes,
    commitRoots: parsed.value.commitRoots,
    ceiling: parsed.value.ceiling,
    ceilingSha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
