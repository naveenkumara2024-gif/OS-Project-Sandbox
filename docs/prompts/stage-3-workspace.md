---
stage: 3
name: workspace
status: approved
created: 2026-10-11
approved_at: 2026-10-11
approved_sha256: 7612be216b4c3052a035c30f4ebf9703f1b1d7a4b069a22627ae19146228b677
---

# Stage 3: Workspace

## 1. Goal

At the end of this stage a request can carry a workspace: a host directory ingested read-only into the cell, plus inline `files`. The program writes inside `/workspace`, which is an overlayfs mount (lower = the ingested snapshot, upper = the change set); the response lists every path the upper layer holds (add, modify, delete) with size and SHA-256, and a unified diff for text files. Nothing reaches the real project until a separate `aegis commit` call, which copies only the listed paths through `O_NOFOLLOW` and `aegis-cell fsop`'s `openat2`-confined opens; `aegis discard` deletes the cell without touching the host tree. Probes 15, 16 and 19 are stopped and proven. If overlay is unavailable the engine falls back to copy-and-diff and says so in the receipt; it never upgrades a manifest's isolation claim beyond what was established.

## 2. Context

- Stages 0 to 2 are done and merged (`main` `4637510`): a cell has 8 namespaces, a verified read-only `/usr`, cgroup limits, `aegis-cell init` as PID 1, and a full receipt at level 2.
- Blueprint sections relied on: "Filesystem: a private root, a copy-on-write workspace, a guarded border", "Egress is not rsync", "N1. Diff-then-commit workspaces", probes table (15, 16, 19).
- **Facts measured in a read-only look and one self-cleaning spike** (kernel `6.18.33.2-microsoft-standard-WSL2`, outside the repository, no host state changed):
  - `overlay` is a registered filesystem (`nodev overlay` in `/proc/filesystems`).
  - An unprivileged user namespace can mount overlayfs with both `lowerdir` and `upperdir` on a tmpfs (`/tmp`): confirmed working, including deletions appearing as whiteout character-device markers (`c--------- 0,0`), consistent with the blueprint.
  - `user.*` extended attributes work on tmpfs (`os.setxattr`/`getxattr` round-tripped). Overlay's own opaque-directory marker (`trusted.overlay.opaque`) needs `CAP_SYS_ADMIN`, which the payload holds in its own namespace, so the kernel maps it to the namespace's `user.*` equivalent inside a user-namespace mount; this is consistent with the measured xattr support and is re-verified by the step 1 spike before the design depends on it.
  - The kernel creates `<workdir>/work` with mode `0000`; it cannot be `readdir`'d (so a recursive delete tool fails on it with `EACCES`), but a plain `rmdir(2)` on it succeeds because `rmdir` only needs write+execute on the *parent*, never on the target. This matches the project's existing rule of no recursive deletion (CLAUDE.md 6.3 spirit; same as `TempDir` in Stage 1).
  - `wslpath -u 'C:\Users\test'` returns `/mnt/c/Users/test` and is on `PATH`.
  - `/usr/include/linux/openat2.h` exists; `RESOLVE_BENEATH` wrappers already exist in `native/src/sys.c` (Stage 0).
- Everything marked **hypothesis** is confirmed or refuted by step 1 before the design depends on it.

## 3. In scope / out of scope

In scope:

- Ingest: `files` (inline content in the request) and an optional host `workspace.source` directory, converted at the border with `wslpath -u` (argument array, never a shell), resolved with `realpath`, checked against an allowlist of roots the owner configures in `policy.default.json`, copied with `rsync -a --delete --safe-links --no-devices --no-specials --max-size=<cap> --exclude-from=<excludes>` into a per-cell staging directory that becomes the overlay's lower layer.
- `aegis-cell fsop`: a new helper subcommand, the only place besides `sys.c` that touches `openat2`; confines every host-side filesystem operation (ingest excludes check, commit opens) to an allowed root with `RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS`.
- Overlay mount inside the cell at `/workspace`: `lowerdir` the staged snapshot (bound read-only from the host side before the cell starts, consistent with the Stage 1 `/usr` approach — not re-walked per directory, since the lower layer has no host submounts), `upperdir`/`workdir` on the cell's own tmpfs. Mounted by the helper before `pivot_root` is not possible (overlay needs its final mount namespace); mounted by `init` after `pivot_root`, before `execve`.
- Fallback: if the overlay mount fails for a reason the probe did not already rule out, copy the lower layer into `/workspace` directly (no overlay) and run; the diff is then computed with an `rsync --dry-run --itemize-changes` comparison instead of walking an upper layer. The receipt reports `workspace: "overlay" | "copy"`.
- Diff extraction: walk the upper layer (or compute the copy-diff), classify each path as `add`, `modify` or `delete`, record size and SHA-256 for the current content, and produce a unified diff for files that decode as UTF-8 text under a size cap; binary files are reported without a diff body.
- `aegis commit`: given a prior run's id and an explicit list of paths (defaulting to all of them, but always explicit in the request the way the manifest states it — no silent "commit everything"), copies each path from the upper layer to the real project root via `fsop`, `O_NOFOLLOW`, refusing symlinks, device files, FIFOs, sockets, set-uid/set-gid bits, and anything over the size cap; refuses `.git/hooks/*` by policy (probe 19) and logs the refusal, not silently dropping it.
- `aegis discard`: removes a cell's upper layer and staging directory without touching the host project.
- Disk cap on the upper layer: `RLIMIT_FSIZE` plus a periodic size check from the supervisor (it already polls every 25 ms for Stage 2 limits); a cap hit is `disk_limit`, extending Stage 2's heuristic with a precise measurement for the overlay case.
- Escape probes 15, 16, 19 with controls; tests; sanitizer and fuzz runs (the launch spec and the new `fsop` request format both get fuzz targets).

Out of scope (and the stage that owns it):

- Capability drop, `no_new_privs`, seccomp, Landlock, manifest/ceiling policy file, environment scrub beyond what Stage 1 already does: **Stage 4**. Until then the payload still has namespace-local capabilities, so the overlay and commit path's safety rests on `O_NOFOLLOW`, `openat2` confinement and policy checks, not on sandboxing the payload itself — stated, not hidden (section 4.9).
- Gateway, MCP tool surface (`mcp__aegis__diff` etc.), NDJSON streaming, sessions that keep a cell between runs: **Stage 5**. This stage's `aegis run`/`commit`/`discard` are one-shot CLI calls operating on a cell kept alive on disk between calls (the upper layer and staging directory persist until `commit` or `discard`), which Stage 5 wraps in a session API.
- Ablation flags: **Stage 6**.

## 4. Design

### 4.1 Request additions

```json
{
  "id": "run-1",
  "command": ["python3", "analyze.py"],
  "files": [{ "path": "analyze.py", "content": "print(1)\n" }],
  "workspace": { "source": "C:\\Users\\me\\proj", "mode": "overlay" }
}
```

`files`: ≤ 256 entries, each `path` a clean relative path (no `..`, no leading `/`, no NUL — reusing `isCleanAbsolutePath`'s sibling rule for relative paths), `content` a UTF-8 string ≤ 1 MiB; total ≤ 16 MiB. Validated and written into the staging directory alongside the ingested `workspace.source`, so the final diff contains only what the *program* changes (files the request itself supplied are part of the lower layer, not the diff), matching the blueprint's intent in the path-guard section.

`workspace.source`: optional. `mode` is `"overlay"` (requested) or omitted (engine decides, reported either way); the engine never claims `overlay` was used when it fell back to `copy` (CLAUDE.md 1.2 item 2).

### 4.2 Ingest (host side, before the cell exists)

1. If `workspace.source` starts with a Windows-style path, convert with `wslpath -u` (`execFile`, argument array). Reject NUL bytes and control characters first (CLAUDE.md 6.3).
2. `realpath` the result; the parent directory is realpath'd if the target itself does not exist yet (needed for commit targets, section 4.6, not for ingest, which requires the source to exist).
3. Confine to an allowlist of roots. **For this stage** the allowlist is a flat list of absolute paths in `policy.default.json` (`ingest_roots`), read-only to the engine; the full ceiling-policy schema is Stage 4. An unlisted root is refused with `isolation_unavailable` layer `workspace_policy` — refused, not silently narrowed.
4. `fsop ingest-check <root> <resolved>` (native): re-resolves the path with `openat2(RESOLVE_BENEATH)` against an fd of the allowed root, closing the TOCTOU window between steps 2 to 3 and the copy (blueprint "Race conditions"). A path that escapes is refused.
5. `rsync -a --delete --safe-links --no-devices --no-specials --max-size=<cap> --exclude-from=<file>` (spawned via `execFile`, never a shell) from the confined source into `<cell-dir>/lower`. The exclude file is generated from fixed, documented patterns (`.ssh`, `.aws`, `.env*`, `.git/hooks`, `node_modules`, build caches) plus `policy.default.json`'s `ingest_excludes`; CLAUDE.md 6.1's rule that the model may ask for less, never more, applies here too — a request cannot widen the excludes.
6. `files` entries are written into `<cell-dir>/lower` after the rsync, each through the same `fsop` confinement, so a `files` path cannot escape the staging directory either.

### 4.3 The overlay mount

Built by `init`, after `pivot_root`, before `execve`, from launch-spec entries the control plane adds (section 4.5): bind the staged lower directory read-only into `/workspace-lower` (composite bind as in Amendment 1 if the staging directory itself has no submounts — it is a tmpfs staging area the engine made, so in practice a single bind suffices; the composite-bind code from Stage 1 is reused unconditionally for uniformity and because it already handles the "no submounts" case as one entry), create `/workspace-upper` and `/workspace-work` on the cell's root tmpfs, then:

```c
mount("overlay", "/workspace", "overlay", 0,
      "lowerdir=/workspace-lower,upperdir=/workspace-upper,workdir=/workspace-work,userxattr");
```

`userxattr` (Linux 5.11+) tells overlayfs to use `user.overlay.*` instead of `trusted.overlay.*`, matching what the spike confirmed works for an unprivileged user namespace. On failure, `init` reports `layer overlay fail <errno>` and switches to the copy fallback (section 4.4) **before** `execve`, never after — the payload never sees a half-built workspace. Working directory for the payload is `/workspace`.

### 4.4 Fallback

If overlay is unavailable (probed and reported, not just tried once per run — the Stage 0-style probe gains an `overlay_userns` fact that `aegis probe` checks with a real mount/unmount in a throwaway cell, and a per-run attempt still happens because a probe result can go stale, matching "probe, never assume"): `init` recursively copies `/workspace-lower` into `/workspace` with the helper's own bounded directory walk (no `cp` subprocess — CLAUDE.md 6.2 and 5.5 forbid a shell and favor bounded, auditable code in the boot/init path) before `execve`. After the run, the host computes the diff by running `rsync --dry-run --itemize-changes` between the staged lower directory and... **this needs the upper content somewhere the host can read**, so the copy fallback's `/workspace` is itself the thing diffed: since there is no separate upper layer, the diff is `rsync`'s itemize output between `<cell-dir>/lower` (pre-run) and the post-run workspace content, which `init` copies back out to `<cell-dir>/copy-result` before exiting (a second bounded copy, read from inside the cell's own tmpfs, written to a host-visible bind the cell held open for exactly this purpose — see Amendment risk in section 9). The receipt says `workspace: "copy"`.

### 4.5 Launch spec and helper changes

New TypeScript: `src/stage/ingest.ts` (steps in 4.2), `src/stage/wslpath.ts` (argument-array wrapper, no shell), `src/launch/workspace-plan.ts` (produces the lower-bind entries and overlay paths for the spec, reusing `RootEntry`-style planning from Stage 1). New spec keys: `WORKSPACE_LOWER` (path), `WORKSPACE_MODE` (`overlay` requested or not), each validated the same way as the Stage 1 `/usr` entries (must resolve under the cell's own directories, not host-arbitrary).

New native: `native/src/fsop.c/.h` (the `fsop` subcommand: `ingest-check`, `commit-open`, each a thin `openat2`-confined operation reading one request line on stdin and writing one result line on stdout — a tiny protocol, fixed buffers, no JSON, mirroring the launch-spec discipline), `native/src/overlay.c/.h` (mount attempt, fallback copy, called from `init.c`).

Modified: `native/src/init.c` (overlay/fallback before exec, `cwd` to `/workspace`), `native/src/boot.c` (bind the lower directory the same way `/usr` is bound), `native/src/spec.{c,h}`.

### 4.6 Diff extraction and commit

`src/collect/diff.ts`: walks the upper layer (overlay case) using the same `fsop`-confined reads as ingest (no raw `fs.readdir` on a path a payload controlled — the upper layer's *names* are payload-controlled even though its *location* is not), classifies whiteout character devices (major/minor `0,0`) as `delete`, everything else as `add` or `modify` by comparing against the lower layer's listing, hashes with `node:crypto` `sha256`, and for UTF-8-decodable files under a diff size cap produces a unified diff (small hand-written differ or, if the owner approves in section 11, the `diff` npm package — flagged as an open question since it is not in the approved dependency list).

`aegis commit <run-id> [--paths p1,p2,...]`: reads the cell's recorded change list (persisted as `<cell-dir>/changes.json`, written by `aegis run` itself — host-internal bookkeeping, never a payload-writable file, so no `__proto__`-style parsing risk, but still read back through the strict schema rules of CLAUDE.md 6.4 since a tampered file should fail closed, not crash), resolves the commit target root the same way ingest resolves `workspace.source` (wslpath, realpath, allowlist, `fsop` confinement), then for each requested path: `fsop commit-open` returns a confined fd opened `O_NOFOLLOW`; the control plane rejects (and reports, not silently skips) any `S_ISLNK`, device, FIFO, socket, set-uid/set-gid target or a path matching `.git/hooks/*`; otherwise copies the upper layer's bytes into it. Response: which paths committed, which were refused and why.

`aegis discard <run-id>`: `rmdir`/`unlink` of the cell's upper, work and staging directories (non-recursive primitives only, as in `TempDir`), no host project access at all.

### 4.7 Receipt additions

```json
{ "workspace": "overlay",
  "changes": [
    { "path": "report.csv", "op": "add", "bytes": 1024, "sha256": "4be2..." },
    { "path": "notes.txt", "op": "modify", "bytes": 12, "sha256": "9c1f...", "diff": "--- a/notes.txt\n+++ b/notes.txt\n..." }
  ],
  "isolation": { "layers": { "...": true, "overlay": true } } }
```

`overlay` joins the tier-3 layer set in ADR 0003 (level 3 requires it, plus the existing tiers 1 and 2).

### 4.8 The five contributions

1. **Diff-then-commit is implemented for the first time**: this is the stage that delivers contribution 1. The change list and diff are produced from the upper layer alone; `commit` is the only path that writes to the real project, and it is a separate, explicit call.
2. Fail-closed receipts: `overlay` is only `true` after a real mount succeeded and was used; a fallback to `copy` is reported, never hidden, and `workspace_policy`/`fsop` failures refuse the run before any host copy happens.
3. Termination causes: `disk_limit` gains a precise upper-layer size measurement.
4. Manifests: `ingest_roots`/`ingest_excludes` are the first piece of policy-as-data read from `policy.default.json`, read-only to the engine, outside every workspace, never mounted into a cell — the full ceiling schema is still Stage 4.
5. Escape corpus: probes 15, 16, 19 added.

### 4.9 What a payload can still do after this stage (stated, not hidden)

- Same as the Stage 2 report's list (uid 0, namespace-local capabilities, unlimited `/usr` read) plus: it can write anywhere under `/workspace` without a capability check, because overlay write access is a normal file permission, not a capability. The safety of `commit` rests entirely on `fsop`'s confinement, `O_NOFOLLOW` and the policy refusal list — **not** on anything stopping the payload from creating a symlink or a `.git/hooks/post-checkout` file inside the upper layer; it is the commit step that must catch and refuse those, and probe 19 proves it does.
- The payload can still create further namespaces and mount things in its own mount namespace (Stage 4 closes this with seccomp denying `mount`/`unshare`/`clone` with `CLONE_NEW*`).

## 5. Files

New TypeScript (about 650 lines, tests excluded): `src/stage/ingest.ts`, `src/stage/wslpath.ts`, `src/launch/workspace-plan.ts`, `src/collect/diff.ts`, `src/collect/commit.ts`, `src/gateway/request.ts` additions, `policy.default.json` (new file at repo root, `ingest_roots`, `ingest_excludes`).

New native (about 500 lines of C): `native/src/fsop.{c,h}`, `native/src/overlay.{c,h}`, `native/src/fuzz_fsop.c`.

New tests: `tests/unit/{ingest,wslpath,workspace-plan,diff}.test.ts`, `tests/integration/{workspace,commit,discard}.test.ts`, `tests/escape/{probe-15-symlink-output,probe-16-path-escape,probe-19-git-hook}.test.ts`.

Modified: `native/src/{init,boot,spec,main}.c`, `src/main.ts` (`run` gains `files`/`workspace`; new `commit`, `discard` modes), `src/probe/probe.ts` (`overlay_userns` fact), `scripts/build-native.mjs`, `docs/SETUP-WSL2.md`, `docs/STAGES.md`, `docs/reports/stage-3.md`, a new ADR if the `diff` package question (section 11) changes anything.

## 6. Dependencies and privileged actions

- **Possible new dependency: the `diff` npm package** for unified-diff text, only if the owner approves it in section 11; otherwise a small hand-written line differ is used (more code, no new dependency). Exact pin, `--ignore-scripts`, transitive count reported either way.
- No new native libraries. `rsync` is already listed in CLAUDE.md 2 as a required external tool, spawned without a shell.
- Packages the owner must install: none beyond what Stage 0's setup guide already lists (`rsync` is already on this machine, confirmed in Stage 0).
- Privileged actions: **None.** `policy.default.json`'s `ingest_roots` is edited by the owner by hand (a text file in the repo, not a privileged operation); the engine only reads it.

## 7. Step-by-step plan

1. **Spike (native, scratchpad, outside the repository):** confirm (a) an unprivileged overlay mount inside the actual cell (not a standalone `unshare`) with lower on the Stage-1-style bound directory and upper/work on the cell's own tmpfs, including a write, a delete (whiteout), and `userxattr`; (b) `rmdir` of the kernel-created `work/work` without `readdir`; (c) `fsop`-style `openat2(RESOLVE_BENEATH)` denies an ingest or commit path that escapes via a symlink planted after the initial check. **If any hypothesis fails, stop and amend this prompt.**
2. `fsop.c`: the confined-operation protocol, `ingest-check`, `commit-open`; fuzz target for its request line.
3. `overlay.c`: mount attempt, bounded fallback copy; wire into `init.c` and `boot.c` (lower bind).
4. TypeScript ingest: `wslpath.ts`, `ingest.ts` (policy roots, excludes, rsync, `fsop ingest-check`, `files` writing).
5. `workspace-plan.ts`, spec additions, `run-cell.ts` wiring; `aegis probe` gains `overlay_userns`.
6. `diff.ts`: upper-layer walk, hashing, unified diff; `changes.json` persistence.
7. `commit.ts` and `discard.ts`; `aegis commit`/`aegis discard` CLI modes.
8. Integration tests (overlay write/delete/diff, fallback path forced by a probe override, commit accept/refuse cases, discard leaves no host trace); then escape probes 15, 16, 19.
9. `npm run check`, both compilers, `clang-tidy`/`clang-format`, fuzz runs (spec parser re-run since it changed, plus the new `fsop` target), report, `docs/STAGES.md`.
10. Commit incrementally on `stage/3-workspace` (created from `main` at approval); the last commit holds the report and `done`.

## 8. Tests and acceptance gate

**Unit and property:** `wslpath` argument handling and rejection of shell metacharacters as *data* (never interpreted); ingest root/exclude matching (fast-check: a path outside every root is always refused); `workspace-plan` entry generation; diff classification (whiteout detection, add/modify/delete) on canned upper-layer fixtures; commit's refusal rules (symlink, device, set-uid, `.git/hooks/*`) over fast-check-generated file-mode/path combinations, asserting the refusal list is never empty when it should trigger and never over-refuses a plain file.

**Integration (`needs_userns`/`needs_overlay`; a missing feature fails with the probed fact and errno, never silently skipped):**

- A `files`-only request with no host workspace runs, writes, and the diff shows exactly the program's own writes (not the `files` the request supplied).
- A host `workspace.source` (a disposable fixture directory, never the owner's real project) is ingested, the program modifies and deletes files, and the diff's `add`/`modify`/`delete` and SHA-256 match what a host-side hash of the upper layer gives, for both the `overlay` and the `copy` fallback (forced via a test-only env override, not a production flag — Stage 6 owns the real ablation mechanism).
- `aegis commit` with an approved path list copies exactly those files to a disposable destination fixture, preserves content, and leaves everything else in the real project (the fixture) untouched; a path not in the approved list is never copied even if it changed.
- `aegis commit` refuses a symlink, a device node, a set-uid file and a `.git/hooks/post-checkout` in the change list, reporting each refusal; none of them reach the destination fixture.
- `aegis discard` removes the cell's cgroup-adjacent and workspace directories (reusing Stage 2's leftover-detection pattern) and never touches the destination fixture.
- A `workspace.source` outside every configured `ingest_roots` entry is refused with `isolation_unavailable`, layer `workspace_policy`, before any `rsync` runs (proved by asserting the fixture's mtimes are untouched).
- The TOCTOU check: a symlink planted inside the resolved source *after* the `realpath` call but *before* `fsop ingest-check` runs is still caught (test replaces the path with a symlink via a timed hook, or more simply asserts that `fsop` re-resolves rather than trusting the TypeScript-side `realpath` alone — a unit-level proof that `openat2` is actually called, not a true race test, which is noted as a limitation).

**Escape probes (disposable fixture; CLAUDE.md 6.5):**

| Probe | Payload | Pass condition | Layer expected to stop it |
| --- | --- | --- | --- |
| 15 | the program's output file is a symlink to the fixture's fake `~/.ssh/id_rsa`; the harness then calls `commit` naming that path | `commit` refuses the symlink (`S_ISLNK`), nothing is written to the fixture's `.ssh`, the refusal is reported | `O_NOFOLLOW` in `fsop commit-open` |
| 16 | the request's `workspace.source` is `../../etc` relative to an allowed root, or the allowed root itself is replaced by a symlink after the initial check | both refused before `rsync` runs; fixture and host `/etc` untouched | `openat2 RESOLVE_BENEATH` confinement + the TOCTOU re-check |
| 19 | the program writes `report.csv` (a legitimate change) and plants `.git/hooks/post-checkout` with executable content | both appear in the diff; `commit` copies `report.csv` and refuses the hook, reporting why; the fixture's real `.git/hooks` (if any) is never touched | commit policy refusal list |

A probe that succeeds against the full stack is a **finding**: reported prominently and the stage stops (CLAUDE.md 7).

**Sanitizers and fuzzing:** integration and escape suites against both helper builds; the `fsop` request-line parser gets a libFuzzer target (at least 5 minutes, no crash) alongside a re-run of the Stage 1 launch-spec fuzz target (it changed in section 4.5).

**Definition of done** (CLAUDE.md 0.6): all of the above measured and recorded; `npm run check` green; native checks clean; `docs/reports/stage-3.md` with commands, measured numbers (diff computation time, overlay vs. copy run-cost difference against Stage 2's baseline, both as measured, not estimated), deviations, limitations (4.9, and the TOCTOU test limitation above), branch and final commit hash; `docs/STAGES.md` `done`; everything committed on `stage/3-workspace`, clean tree. Nothing pushed or merged by Claude.

## 9. Risks and mitigations

- **Copy-fallback's diff needs upper content visible to the host** (4.4): the design reads it back through a host-held bind rather than trusting anything the payload writes to a shared location without confinement; the bind is read-only from the cell's perspective is not quite right either — stated as an open question (section 11, item 2) rather than resolved by assumption, because it is a real design fork (read-back via a bind vs. a second `rsync` pass vs. accepting a slower, simpler always-overlay-or-refuse policy).
- **Overlay-in-userns flakiness across kernel point releases**: the per-run probe (not just a cached Stage-0-style fact) catches a regression; fallback is explicit and reported.
- **TOCTOU between path checks and the copy**: mitigated by `fsop`'s `openat2(RESOLVE_BENEATH)` re-resolution at the moment of the operation, as the blueprint specifies; the test limitation above is recorded, not hidden.
- **`.git/hooks` refusal list growing stale** (new hook names): the refusal is by directory (`.git/hooks/*`) not by filename, so this is not a risk in practice; recorded anyway.
- **rsync exclude patterns missing something sensitive**: the list is reviewed in the report; `policy.default.json` lets the owner add more without a code change.
- **Diff size**: text diffs are capped; a large binary or a huge text file reports size and hash without a diff body rather than building an unbounded string (CLAUDE.md 5.1 bounded-buffer rule extends here).
- **Supply chain**: the `diff` package question is explicit (section 11), not assumed.

## 10. Rollback

All work on `stage/3-workspace`; back out with `git revert` or by deleting the branch. Runtime state: per-cell staging/upper/work directories under the temp parent (same reaper pattern as Stage 1/2) and `policy.default.json` (a tracked file, revert removes it). No system state.

## 11. Decisions recorded from the owner (2026-10-11)

All four questions were answered with the recommended option; the design above already reflects them.

1. **Diff rendering:** a hand-written line differ, no new dependency.
2. **Copy-fallback diff:** the upper content is read back through a host-held bind the cell holds open (section 4.4).
3. **Test ingest roots:** a disposable fixture directory under the temp directory; the owner's real project is not listed in `policy.default.json` yet.
4. **Commit destination safety net:** the explicit allowlist in `policy.default.json` alone; no additional git-tracked-directory check.
