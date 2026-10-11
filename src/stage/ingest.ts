import { execFile } from 'node:child_process';
import { mkdirSync, realpath as realpathCb, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { promisify } from 'node:util';
import { err, errFromException, ok, type Result } from '../util/result.js';
import { looksLikeWindowsPath, wslpathToLinux } from './wslpath.js';

// Host-side ingest (blueprint "Path guard and staging"; CLAUDE.md 6.1 item 5, 6.2, 6.3, 6.4).
// Steps: convert, realpath, confine to an allowlisted root, re-check with fsop (TOCTOU close),
// rsync in, then write the request's inline files. Nothing here runs a shell or interpolates a
// path into a command string.

const realpath = promisify(realpathCb);
const MAX_FILES_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 256;
const MAX_INGEST_BYTES = '64m'; // --max-size, per file (blueprint ingest line)

export interface IngestPolicy {
  readonly ingestRoots: readonly string[];
  readonly ingestExcludes: readonly string[];
}

export interface InlineFile {
  readonly path: string;
  readonly content: string;
}

export interface IngestEnv {
  readonly fsopPath: string;
  readonly execFileFn?: typeof execFile;
}

/** Relative path, no leading /, no NUL, no ".." component, no empty component. */
export function isCleanRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\0')) {
    return false;
  }
  return path.split('/').every((p) => p !== '' && p !== '.' && p !== '..');
}

export function validateInlineFiles(files: readonly InlineFile[]): Result<void> {
  if (files.length > MAX_FILES) {
    return err('E2BIG', 'too many files in the request');
  }
  let total = 0;
  const seen = new Set<string>();
  for (const f of files) {
    if (!isCleanRelativePath(f.path)) {
      return err('EINVAL', `file path is not a clean relative path: ${f.path}`);
    }
    if (seen.has(f.path)) {
      return err('EINVAL', `duplicate file path: ${f.path}`);
    }
    seen.add(f.path);
    const bytes = Buffer.byteLength(f.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) {
      return err('E2BIG', `file exceeds the per-file byte cap: ${f.path}`);
    }
    total += bytes;
  }
  if (total > MAX_FILES_TOTAL_BYTES) {
    return err('E2BIG', 'files exceed the total byte cap');
  }
  return ok(undefined);
}

/** True when `resolved` is exactly one of `roots`, or strictly beneath one (trailing separator). */
export function isUnderAnyRoot(resolved: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const r = normalize(root);
    return resolved === r || resolved.startsWith(r.endsWith('/') ? r : `${r}/`);
  });
}

function runFsopIngestCheck(
  fsopPath: string,
  root: string,
  relPath: string,
  execFileFn: typeof execFile,
): Promise<Result<void>> {
  return new Promise((resolve) => {
    execFileFn(fsopPath, ['fsop', 'ingest-check', root, relPath], { timeout: 5000 }, (error) => {
      if (error) {
        resolve(err('EACCES', 'fsop ingest-check refused the path'));
        return;
      }
      resolve(ok(undefined));
    });
  });
}

export interface ResolvedSource {
  readonly root: string;
  readonly resolved: string;
}

/**
 * Resolves and confines a requested workspace source: converts a Windows path, realpaths it,
 * checks it is under an allowed root, then re-checks with fsop's openat2(RESOLVE_BENEATH) at the
 * moment of use, closing the gap between this check and the rsync call (blueprint "Race
 * conditions"; CLAUDE.md 6.3).
 */
export async function resolveIngestSource(
  requested: string,
  policy: IngestPolicy,
  env: IngestEnv,
): Promise<Result<ResolvedSource>> {
  if (requested.includes('\0')) {
    return err('EINVAL', 'workspace source contains a NUL byte');
  }
  let path = requested;
  if (looksLikeWindowsPath(requested)) {
    const converted = await wslpathToLinux(requested);
    if (!converted.ok) return converted;
    path = converted.value;
  }
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch (e) {
    return errFromException(e, 'realpath workspace source');
  }
  const root = policy.ingestRoots.find(
    (r) => resolved === normalize(r) || resolved.startsWith(`${normalize(r)}/`),
  );
  if (root === undefined) {
    return err('EACCES', 'workspace source is not under an allowed ingest root');
  }
  const normRoot = normalize(root);
  const relPath = resolved === normRoot ? '.' : resolved.slice(normRoot.length + 1);
  const execFileFn = env.execFileFn ?? execFile;
  const check = await runFsopIngestCheck(env.fsopPath, root, relPath, execFileFn);
  if (!check.ok) {
    return check;
  }
  return ok({ root, resolved });
}

function excludeFileContent(policy: IngestPolicy): string {
  return `${policy.ingestExcludes.join('\n')}\n`;
}

export interface RsyncEnv {
  readonly execFileFn?: typeof execFile;
  /** Writes the exclude list to a temp file and returns its path. */
  readonly writeExcludeFile: (content: string) => Promise<Result<string>>;
}

/** `rsync -a --delete --safe-links --no-devices --no-specials ...`, spawned as an argument array. */
export function rsyncIngest(
  source: ResolvedSource,
  destination: string,
  policy: IngestPolicy,
  env: RsyncEnv,
): Promise<Result<void>> {
  return new Promise((resolve) => {
    void (async () => {
      const excludeFile = await env.writeExcludeFile(excludeFileContent(policy));
      if (!excludeFile.ok) {
        resolve(excludeFile);
        return;
      }
      const src = source.resolved.endsWith('/') ? source.resolved : `${source.resolved}/`;
      const args = [
        '-a',
        '--delete',
        '--safe-links',
        '--no-devices',
        '--no-specials',
        `--max-size=${MAX_INGEST_BYTES}`,
        `--exclude-from=${excludeFile.value}`,
        src,
        destination.endsWith('/') ? destination : `${destination}/`,
      ];
      const execFileFn = env.execFileFn ?? execFile;
      execFileFn('/usr/bin/rsync', args, { timeout: 60000 }, (error) => {
        resolve(error ? errFromException(error, 'rsync ingest') : ok(undefined));
      });
    })().catch((e: unknown) => {
      resolve(errFromException(e, 'rsync ingest'));
    });
  });
}

/**
 * Writes the request's inline `files` into the staged lower directory, after the rsync ingest.
 * Each path is already validated clean and relative; joined directly since `isCleanRelativePath`
 * rules out any `..` or absolute escape.
 */
export function writeInlineFiles(destination: string, files: readonly InlineFile[]): Result<void> {
  const v = validateInlineFiles(files);
  if (!v.ok) return v;
  try {
    for (const f of files) {
      const target = join(destination, f.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content, 'utf8');
    }
    return ok(undefined);
  } catch (e) {
    return errFromException(e, 'write inline files');
  }
}
