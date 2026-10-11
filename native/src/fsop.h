#ifndef AEGIS_FSOP_H
#define AEGIS_FSOP_H

/*
 * `aegis-cell fsop <op> ...`: the control plane's confined filesystem helper (CLAUDE.md 4, 6.3).
 * Besides sys.c this is the only translation unit that resolves an untrusted path: every
 * resolution goes through openat2(RESOLVE_BENEATH), closing the gap between a check made in
 * TypeScript (realpath, an allowlist) and the moment the file is actually touched.
 *
 * Usage:
 *   fsop ingest-check <root> <rel-path>
 *     Confirms <rel-path> resolves beneath <root> right now. Exit 0 ok, 1 refused.
 *   fsop commit-copy <dest-root> <rel-path> <source-abs-path> <max-bytes>
 *     Opens <rel-path> beneath <dest-root> with O_NOFOLLOW and no symlink component, refuses an
 *     existing non-regular target or set-uid/set-gid bits, creates missing parent directories
 *     (also confined), then copies at most <max-bytes> from <source-abs-path>. Exit 0 ok
 *     ("ok <bytes>" on stdout), 1 a path problem, 2 refused for a policy reason ("refused: ..."
 *     on stdout), 3 the source is larger than the cap.
 *
 * Returns the process exit status described above, or 64 for a usage error.
 */
int aegis_fsop_run(int argc, char **argv);

#endif
