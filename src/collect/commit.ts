import { execFile } from 'node:child_process';
import { realpath as realpathCb } from 'node:fs';
import { normalize } from 'node:path';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { Change } from './diff.js';
import { err, errFromException, ok, type Result } from '../util/result.js';

// `aegis commit` (CLAUDE.md 1.2 item 1; blueprint "Egress is not rsync"). Copies only the
// requested paths from the upper/result layer to the real project, each through
// `aegis-cell fsop commit-copy`, which opens the destination with O_NOFOLLOW and no symlink
// component (CLAUDE.md 6.3). The control plane refuses, and reports, every path a cell's own
// change list already marks as unsafe before fsop is even invoked.

const realpath = promisify(realpathCb);
const MAX_COMMIT_BYTES = 8 * 1024 * 1024;

export interface CommitPolicy {
  readonly commitRoots: readonly string[];
}

export interface CommitTarget {
  readonly path: string;
  readonly sourceAbs: string;
}

export type CommitOutcome =
  | { readonly path: string; readonly status: 'committed'; readonly bytes: number }
  | { readonly path: string; readonly status: 'refused'; readonly reason: string };

export interface CommitEnv {
  readonly fsopPath: string;
  readonly execFileFn?: typeof execFile;
}

const HOOK_PATH = /(^|\/)\.git\/hooks\//;

/** Refusal reasons the control plane checks before fsop ever runs (policy, not confinement). */
function policyRefusal(change: Change): string | null {
  if (HOOK_PATH.test(change.path)) {
    return 'git hooks are never committed';
  }
  if (change.diff?.startsWith('symlink -> ') === true) {
    return 'symlinks are never committed';
  }
  if (change.op === 'delete') {
    return null; // deletions are applied by the caller separately; see commitChanges
  }
  return null;
}

function runFsopCommitCopy(
  destRoot: string,
  relPath: string,
  sourceAbs: string,
  env: CommitEnv,
): Promise<Result<number>> {
  return new Promise((resolve) => {
    const execFileFn = env.execFileFn ?? execFile;
    execFileFn(
      env.fsopPath,
      ['fsop', 'commit-copy', destRoot, relPath, sourceAbs, String(MAX_COMMIT_BYTES)],
      { timeout: 10000 },
      (error, stdout) => {
        if (error) {
          resolve(err('EACCES', stdout.trim() !== '' ? stdout.trim() : 'fsop commit-copy refused'));
          return;
        }
        const m = /^ok (\d+)/.exec(stdout.trim());
        resolve(m?.[1] !== undefined ? ok(Number(m[1])) : err('EPROTO', 'unexpected fsop output'));
      },
    );
  });
}

/**
 * Resolves and confines the destination root the same way ingest resolves a source: realpath,
 * then membership in the owner's explicit allowlist (CLAUDE.md 6.4: the ceiling the model cannot
 * widen).
 */
export async function resolveCommitRoot(
  requested: string,
  policy: CommitPolicy,
): Promise<Result<string>> {
  if (requested.includes('\0')) {
    return err('EINVAL', 'commit root contains a NUL byte');
  }
  let resolved: string;
  try {
    resolved = await realpath(requested);
  } catch (e) {
    return errFromException(e, 'realpath commit root');
  }
  const allowed = policy.commitRoots.some((r) => {
    const n = normalize(r);
    return resolved === n || resolved.startsWith(`${n}/`);
  });
  if (!allowed) {
    return err('EACCES', 'commit root is not in the allowed list');
  }
  return ok(resolved);
}

/**
 * Commits the requested subset of `changes` (deletions included: those are not copied, they are
 * applied as a removal note in the outcome — Stage 3 does not remove files from the real project
 * automatically; a delete is reported but requires the caller to act, matching the blueprint's
 * "the commit step becomes the human checkpoint").
 */
export async function commitChanges(
  destRoot: string,
  /** Where the changed content actually lives: the overlay upper directory, or the copy result. */
  contentDir: string,
  changes: readonly Change[],
  requestedPaths: readonly string[] | null,
  env: CommitEnv,
): Promise<CommitOutcome[]> {
  const wanted = requestedPaths === null ? null : new Set(requestedPaths);
  const outcomes: CommitOutcome[] = [];
  for (const change of changes) {
    if (wanted !== null && !wanted.has(change.path)) {
      continue;
    }
    const refusal = policyRefusal(change);
    if (refusal !== null) {
      outcomes.push({ path: change.path, status: 'refused', reason: refusal });
      continue;
    }
    if (change.op === 'delete') {
      outcomes.push({
        path: change.path,
        status: 'refused',
        reason: 'deletions are reported, not applied automatically in this stage',
      });
      continue;
    }
    outcomes.push(await commitOne(destRoot, join(contentDir, change.path), change, env));
  }
  return outcomes;
}

async function commitOne(
  destRoot: string,
  sourceAbs: string,
  change: Change,
  env: CommitEnv,
): Promise<CommitOutcome> {
  const copied = await runFsopCommitCopy(destRoot, change.path, sourceAbs, env);
  if (!copied.ok) {
    return { path: change.path, status: 'refused', reason: copied.error.context };
  }
  return { path: change.path, status: 'committed', bytes: copied.value };
}
