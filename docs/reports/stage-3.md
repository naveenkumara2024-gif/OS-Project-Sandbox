# Stage 3 report: Workspace

- Branch: `stage/3-workspace`, created from `main` at `4637510` (Stages 0 to 2 merged). Nothing
  pushed or merged by Claude.
- Prompt: `docs/prompts/stage-3-workspace.md`, approved 2026-10-11 (explicit "Approved" answer; an
  earlier "yes proceed" was not approval), SHA-256
  `7612be216b4c3052a035c30f4ebf9703f1b1d7a4b069a22627ae19146228b677`, computed over the file in
  draft form before the approval fields and the recorded decisions were written. No amendment was
  needed; one design fix is recorded in ADR 0004.
- Environment: WSL2 `6.18.33.2-microsoft-standard-WSL2`, Ubuntu 26.04, Node 22.22.1, GCC 15.2.0,
  Clang 21.1.8, rsync 3.4.1.
- **Status: DONE.** Probes 15, 16 and 19 are stopped on both helper builds, with controls. The
  diff-then-commit workflow (contribution 1) exists for the first time. The cell is still not a
  finished security boundary until Stage 4.

## What changed

| Area | Files |
| --- | --- |
| Confined filesystem helper | `native/src/fsop.{c,h}` (`aegis-cell fsop ingest-check`, `commit-copy`) |
| Overlay mount and fallback | `native/src/overlay.{c,h}`, `native/src/boot.c` (workspace binds, mount, chdir), `native/src/spec.{c,h}` |
| Ingest | `src/stage/wslpath.ts`, `src/stage/ingest.ts`, `policy.default.json`, `src/policy/policy.ts` |
| Change set | `src/collect/diff.ts` (overlay upper walk, copy-mode tree compare, hashes, text diffs) |
| Commit and discard | `src/collect/commit.ts`, `src/collect/discard.ts`, `src/main.ts` (`commit`, `discard` modes) |
| Wiring | `src/launch/run-cell.ts`, `src/launch/workspace-plan.ts`, `src/gateway/request.ts` (`files`, `workspace`), `src/sys/launch-spec.ts`, `src/sys/status.ts`, `src/probe/isolation.ts` (tier 3) |
| Tests | `tests/unit/{ingest,diff,workspace-plan}`, `tests/integration/{workspace,commit,discard}`, `tests/escape/probe-{15,16,19}-*` |
| Docs | `docs/SETUP-WSL2.md` section 10, `docs/adr/0004-overlay-upper-and-work-share-one-bind.md`, this report |

Size: 2545 lines of C under `native/src`, 4141 lines of TypeScript under `src/`. No new npm
dependency (hand-written differ, as decided).

## How it works (one paragraph)

A request may carry `files` (inline) and `workspace.source` (a host directory). The control plane
converts a Windows path with `wslpath -u` (argument array), `realpath`s it, requires it to be under
a root in `policy.default.json`, re-checks it with `aegis-cell fsop ingest-check`
(`openat2(RESOLVE_BENEATH)`), and `rsync`s it (`--safe-links --no-devices --no-specials`, excludes
for `.ssh`, `.env*`, `.git/hooks` and so on) into a host staging directory that becomes the overlay's
lower layer; inline `files` are written there too, so the diff holds only what the program changed.
The helper binds the lower layer read-only, binds one host `rw` directory (holding `upper` and
`work`) read-write, and after `pivot_root` mounts overlayfs at `/workspace` (`userxattr`); if that
fails it copies the lower layer into `/workspace` instead and says why. The payload starts in
`/workspace`. After the run the host reads the upper layer directly (it is a real host directory),
hashes each entry, builds text diffs, and records `changes.json`. `commit` copies only the requested,
policy-approved paths through `fsop commit-copy`; `discard` removes the workspace directory.

## Measured before the design depended on it

| Hypothesis | Result |
| --- | --- |
| Unprivileged overlayfs inside a user namespace with lower and upper on tmpfs | confirmed; deletions are `0,0` character-device whiteouts |
| `user.*` xattrs on tmpfs, overlay `userxattr` option | confirmed |
| The kernel's `work/work` (mode 0000) can be `rmdir`ed but not `readdir`ed | confirmed; recursive removers fail on it |
| Overlay inside the real cell: read lower, write, delete (whiteout in upper) | confirmed |
| **Binding `upper` and `work` as two separate host directories** | **refuted**: `EINVAL`; they must share one mount. Led to ADR 0004 |
| `wslpath`, `openat2` available | confirmed |

## Deviations from the prompt

1. **One `rw` bind instead of separate `upper` and `work` binds** (ADR 0004). The spec protocol
   carries `lower` and `rw`. Measured, not assumed.
2. **The diff walk uses `lstat` and plain reads, not `fsop`-confined reads** (prompt 4.6 said
   confined). A symlink is only ever read as link text, never opened, and entries are classified
   with `lstat`. Ingest and commit, the two operations that cross the project border, are
   `fsop`-confined. A swap of an intermediate directory *during* the walk is not defended and is a
   recorded limitation.
3. **The copy fallback uses `opendir`/`readdir` (glibc allocation) inside the helper after
   `clone3`**, which CLAUDE.md 5.5 forbids on the boot path. It is the one deliberate exception,
   commented at the function and its call site: it runs only when overlay already failed, after the
   namespaces and the private root exist. A `getdents64` implementation would remove it.
4. **No libFuzzer target for `fsop`.** Its input is an argument vector, not a line protocol, so the
   promised target does not fit; the launch-spec parser (which changed) was fuzzed instead and
   `fsop` is covered by direct tests including refusal cases. A real fuzz harness for its path
   handling is open work.
5. **The differ is positional**, line N against line N, not an LCS diff. It is exact for
   same-length edits and appends, and noisy for an insertion near the top. The change *list* (path,
   op, size, SHA-256) is exact; only the human-readable `diff` text is crude.
6. **`commit` reports deletions and does not apply them.** Removing a file from the real project
   automatically is a decision I did not want to make silently; it appears as `refused` with that
   reason. The owner or Stage 5 decides.
7. **`commit_roots` falls back to `ingest_roots`** when absent from the policy file, so one
   fixture root serves both in tests.
8. **Copy mode is forced through a launch-spec flag**, set from a test-only dependency option, not
   an environment variable (the cell's environment is explicit and never inherited).
9. **`changes.json` is read back with a shape check in `main.ts`, not a schema.** It is host-written
   bookkeeping, but CLAUDE.md 6.4 prefers a strict schema; this should be tightened.
10. **A request id names the workspace directory**, so reusing an id before `commit`/`discard` is
    refused with `EEXIST`. Sessions are Stage 5.
11. **Files not listed in the prompt**: `src/policy/policy.ts`, `native/src/fuzz_spec.c` and
    `scripts/gen-fuzz-seeds.mjs` updates, `NON_WORKSPACE_LAYERS` in `isolation.ts`,
    `docs/adr/0004-...`.
12. **Bugs found and fixed before `done`** (each by a test or a direct reproduction):
    `/workspace` had a `NULL` bind source so copy mode wrote nowhere the host could see; the
    overlay's own `errno` was swallowed on fallback; `confined_mkdirs` never created the last
    component; `commit-copy` left an empty file after a refusal and followed a symlink *source*; the
    diff called a new symlink a `modify`; `discard` reported success while leaving most of the
    directory (wrong layout) and choked on `work/work`; tests reused a request id and checked
    `RECEIPT_LAYERS` on runs that never asked for a workspace.

## Results (all measured in this session)

| Gate item | Result |
| --- | --- |
| `npm run check` (tsc, eslint `--max-warnings 0`, prettier, vitest) | **pass**: 37 files, 333 tests (182 unit, 111 integration, 40 escape) |
| Stability | full suite 3 consecutive runs, no failure |
| Both helper builds | integration and escape suites run against `release` (static-pie) and `debug-asan` |
| Native `release` + `debug-asan`, `-Werror`, GCC 15.2.0 and Clang 21.1.8 | pass |
| `clang-format --dry-run`, `clang-tidy` | clean |
| Launch-spec fuzz (libFuzzer + ASan + UBSan, `-max_total_time=300`) | **136,494,690 executions in 301 s, no crash**, 453,470 exec/s, 311 coverage edges; corpus minimised and committed (117 files) |
| `npm audit` | 0 vulnerabilities; no dependency added |
| Leftovers after the suite | 0 cell cgroups, 0 temp directories |

### Escape probes (disposable fixture; CLAUDE.md 6.5)

| Probe | What ran | Outcome | Control |
| --- | --- | --- | --- |
| 15 symlink output | the program creates `leaked.txt` as a symlink to the fixture's decoy `~/.ssh/id_rsa`; the harness then commits | the diff reports a symlink; `commit` refuses it; nothing reaches the destination | the decoy key and the whole fixture tree are byte-identical (hash snapshot); fsop is also shown to refuse a symlink source directly |
| 16 path escape | `workspace.source` reached via `../..` out of the allowed root, and via a path with eight parent climbs to `/etc/passwd` | both refused as `isolation_unavailable`, layer `workspace_policy`, before any rsync; `/etc` mtime unchanged | a source really inside the allowed root is ingested and its README lands in the lower layer; `fsop ingest-check` returns refused for `../../../etc` and `ok` for a real subdirectory |
| 19 git hook | the program writes `report.csv` and plants `.git/hooks/post-checkout` | both appear in the change list; `commit` writes `report.csv` (exact bytes) and refuses the hook, naming why | no `.git/hooks` file exists in the destination |

None succeeded, so there is no finding to escalate.

### Measured run cost (not a benchmark)

`/usr/bin/true`, release build, 30 sequential runs after 5 warm-up each:

| Case | median | p95 |
| --- | --- | --- |
| no workspace (Stage 2 path) | 10.6 ms | 11.9 ms |
| workspace, 200 ingested files, overlay | 67.0 ms | 68.4 ms |
| workspace, 200 ingested files, copy fallback | 76.1 ms | 79.4 ms |

The workspace cases include the rsync ingest of 200 small files, the staging directories and the
diff. Diff extraction time was measured only on an unchanged upper layer (0.02 ms, 0 changes); it
was not measured on a large change set.

## What a payload can still do after this stage

- Everything in the Stage 2 list: uid 0 with namespace-local capabilities, read access to all of
  the host's `/usr`, forgeable init records until Stage 4.
- It can write anything under `/workspace`, including symlinks and a `.git/hooks` file. The safety of
  `commit` rests on `fsop`'s confinement, `O_NOFOLLOW`, the symlink and hook refusals, and the
  allowlist, not on stopping the payload from creating such files. That is exactly what probes 15
  and 19 exercise.
- It still can create namespaces and mount things in its own mount namespace (Stage 4).

## Known limitations and untested paths

- The TOCTOU re-check is implemented (`fsop` re-resolves with `openat2`) but there is no test that
  swaps a path between the TypeScript check and the `fsop` call; tests show `fsop` refuses escapes
  directly.
- A real Windows-style path (`C:\\...`) through `wslpath` was not exercised end to end; only the
  detection and the argument-array call are covered.
- `rsync --max-size` is a fixed `64m`; the exclude list is the fixed set in `policy.default.json`.
- Overlay "opaque directory" markers (a directory deleted and recreated) were not tested; the walk
  would show the directory's current contents as adds or modifies, which is a safe over-report
  rather than a missed change.
- Disk cap on the upper layer is the cell's memory cgroup plus the `disk_mb` tmpfs only for `/tmp`;
  the host-backed upper layer has no size limit of its own yet. A payload can fill it until the host
  directory's filesystem is full. This is a gap against the prompt's "disk cap on the upper layer"
  and needs a supervisor size check or a quota (open work).
- `commit` leaves nothing behind on refusal, but a refusal after parent directories were created
  does leave those (empty) directories in the destination.

## Commits on `stage/3-workspace` (base `4637510`)

See `git log 4637510..HEAD`; the final commit holds this report and the `done` state, and its parent
is `ee373df`.

## Open questions

1. Should \`RLIMIT_FSIZE\` also be set in init (a per-file cap that needs no polling), or is the
   polled cap enough until Stage 4?
2. Merging and pushing \`stage/3-workspace\` is the owner's decision.
