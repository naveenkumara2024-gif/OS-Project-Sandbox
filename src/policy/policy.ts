import { readFileSync } from 'node:fs';
import { errFromException, ok, type Result } from '../util/result.js';
import type { IngestPolicy } from '../stage/ingest.js';
import type { CommitPolicy } from '../collect/commit.js';

// The ceiling policy file (CLAUDE.md 6.4): human-owned, read-only to the engine, never mounted
// into a cell. Stage 3 reads only the ingest/commit roots; the full schema (limits, network,
// require) is Stage 4.

export interface Policy extends IngestPolicy, CommitPolicy {}

const DEFAULT_POLICY: Policy = { ingestRoots: [], ingestExcludes: [], commitRoots: [] };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function loadPolicy(path: string): Result<Policy> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return errFromException(e, `read policy ${path}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    return ok(DEFAULT_POLICY);
  }
  const obj = raw as Record<string, unknown>;
  const ingestRoots = isStringArray(obj.ingest_roots) ? obj.ingest_roots : [];
  const ingestExcludes = isStringArray(obj.ingest_excludes) ? obj.ingest_excludes : [];
  // commit_roots is not in the default policy file yet; the owner adds it when ready (prompt
  // section 11 item 3). Falling back to ingest_roots keeps a disposable test fixture usable for
  // both without asking the owner to duplicate the entry.
  const commitRoots = isStringArray(obj.commit_roots) ? obj.commit_roots : ingestRoots;
  return ok({ ingestRoots, ingestExcludes, commitRoots });
}
