import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { errFromException, ok, type Result } from '../util/result.js';

// Diff extraction (CLAUDE.md 1.2 item 1; blueprint "N1. Diff-then-commit workspaces"). The upper
// layer is the exact change set: this module turns it (or, in copy mode, a two-tree compare)
// into the change list the receipt carries.
//
// Every entry is read with lstat, never a stat that follows a symlink, and a symlink's own
// content is never dereferenced: an attacker-controlled name inside the upper directory can point
// anywhere, but that is only ever read as link text here, never opened (CLAUDE.md 6.3).

export type ChangeOp = 'add' | 'modify' | 'delete';

export interface Change {
  readonly path: string;
  readonly op: ChangeOp;
  /** Null for a delete, and for a symlink (its target is reported in `diff` instead). */
  readonly bytes: number | null;
  readonly sha256: string | null;
  /** A unified-looking diff for small UTF-8 text; absent for binary, large or deleted files. */
  readonly diff?: string;
}

const MAX_DIFF_SOURCE_BYTES = 256 * 1024;
/** Overlay's whiteout marker: a character device with major and minor both 0 (overlayfs(5)). */
function isWhiteout(st: { isCharacterDevice(): boolean; rdev: number }): boolean {
  return st.isCharacterDevice() && st.rdev === 0;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function isUtf8Text(buf: Buffer): boolean {
  // A valid decode that round-trips is treated as text; anything else is binary (CLAUDE.md 5.1:
  // prefer explicit checks over guessing from a file extension).
  return (
    buf.length <= MAX_DIFF_SOURCE_BYTES && Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)
  );
}

/** A minimal, dependency-free unified-style diff: whole old/new text, line by line (no hunks). */
function simpleDiff(oldText: string | null, newText: string): string {
  const oldLines = oldText === null ? [] : oldText.split('\n');
  const newLines = newText.split('\n');
  const out: string[] = ['--- a', '+++ b'];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) continue;
    if (o !== undefined) out.push(`-${o}`);
    if (n !== undefined) out.push(`+${n}`);
  }
  return `${out.join('\n')}\n`;
}

interface Entry {
  readonly rel: string;
  readonly abs: string;
}

function walk(root: string, dir = ''): Entry[] {
  const abs = dir === '' ? root : join(root, dir);
  const out: Entry[] = [];
  for (const name of readdirSync(abs).sort()) {
    const rel = dir === '' ? name : `${dir}/${name}`;
    const full = join(abs, name);
    const st = lstatSync(full);
    out.push({ rel, abs: full });
    if (st.isDirectory()) {
      out.push(...walk(root, rel));
    }
  }
  return out;
}

function describe(abs: string, lowerAbs: string | null): Result<Change | null> {
  try {
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      return ok(null); // directories themselves are not reported; their contents are
    }
    if (isWhiteout(st)) {
      return ok({ path: '', op: 'delete', bytes: null, sha256: null });
    }
    if (st.isSymbolicLink()) {
      const target = readlinkSync(abs);
      let existedInLower = false;
      if (lowerAbs !== null) {
        try {
          lstatSync(lowerAbs);
          existedInLower = true;
        } catch {
          existedInLower = false;
        }
      }
      return ok({
        path: '',
        op: existedInLower ? 'modify' : 'add',
        bytes: null,
        sha256: sha256(Buffer.from(target, 'utf8')),
        diff: `symlink -> ${target}`,
      });
    }
    if (!st.isFile()) {
      return ok(null); // device, socket or FIFO: never produced by a cell, ignored if seen
    }
    const content = readFileSync(abs);
    const hash = sha256(content);
    let op: ChangeOp = 'add';
    let diff: string | undefined;
    if (lowerAbs !== null) {
      try {
        const lowerContent = readFileSync(lowerAbs);
        if (sha256(lowerContent) === hash) {
          return ok(null); // identical to the lower layer: not a change
        }
        op = 'modify';
        if (isUtf8Text(content) && isUtf8Text(lowerContent)) {
          diff = simpleDiff(lowerContent.toString('utf8'), content.toString('utf8'));
        }
      } catch {
        op = 'add'; // not present in the lower layer after all
      }
    } else if (isUtf8Text(content)) {
      diff = simpleDiff(null, content.toString('utf8'));
    }
    return ok({
      path: '',
      op,
      bytes: content.length,
      sha256: hash,
      ...(diff !== undefined ? { diff } : {}),
    });
  } catch (e) {
    return errFromException(e, `describe ${abs}`);
  }
}

/** Overlay mode: the upper directory already is the exact change set. */
export function diffOverlayUpper(lowerDir: string, upperDir: string): Result<Change[]> {
  const changes: Change[] = [];
  let entries: Entry[];
  try {
    entries = walk(upperDir);
  } catch (e) {
    return errFromException(e, 'walk upper layer');
  }
  for (const e of entries) {
    const lowerAbs = join(lowerDir, e.rel);
    const d = describe(e.abs, lowerAbs);
    if (!d.ok) return d;
    if (d.value !== null) {
      changes.push({ ...d.value, path: e.rel });
    }
  }
  return ok(changes);
}

/** Copy mode: upper holds the complete final tree, so both sides are walked. */
export function diffCopyResult(lowerDir: string, resultDir: string): Result<Change[]> {
  const changes: Change[] = [];
  let lowerEntries: Entry[];
  let resultEntries: Entry[];
  try {
    lowerEntries = walk(lowerDir);
    resultEntries = walk(resultDir);
  } catch (e) {
    return errFromException(e, 'walk workspace trees');
  }
  const resultByRel = new Map(resultEntries.map((e) => [e.rel, e]));
  const lowerRels = new Set(lowerEntries.map((e) => e.rel));

  for (const e of resultEntries) {
    const lowerAbs = lowerRels.has(e.rel) ? join(lowerDir, e.rel) : null;
    const d = describe(e.abs, lowerAbs);
    if (!d.ok) return d;
    if (d.value !== null) {
      changes.push({ ...d.value, path: e.rel });
    }
  }
  for (const e of lowerEntries) {
    if (resultByRel.has(e.rel)) continue;
    try {
      if (lstatSync(e.abs).isDirectory()) continue;
    } catch {
      continue;
    }
    changes.push({ path: e.rel, op: 'delete', bytes: null, sha256: null });
  }
  return ok(changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}

/**
 * Total size in bytes of the regular files under `root`, by lstat only (no symlink is followed).
 * Used by the supervisor to cap the workspace's upper layer; returns early once `stopAfter` is
 * exceeded so a huge tree does not make every poll expensive.
 */
export function treeBytes(root: string, stopAfter: number): number {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // e.g. the kernel's mode-0000 work/work, which is not under upper anyway
    }
    for (const name of names) {
      const full = join(dir, name);
      try {
        const st = lstatSync(full);
        if (st.isDirectory()) stack.push(full);
        else if (st.isFile()) total += st.size;
      } catch {
        // Vanished between listing and stat.
      }
      if (total > stopAfter) return total;
    }
  }
  return total;
}
