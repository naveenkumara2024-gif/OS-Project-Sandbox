# Stage 1 report: Core cell

- Branch: `stage/1-core-cell`, created from the tip of `stage/0-scaffold` (`3b8dcc3`), as the owner
  decided (prompt section 11 item 1). Nothing pushed or merged by Claude.
- Prompt: `docs/prompts/stage-1-core-cell.md`, approved 2026-10-11 **with Amendment 1**, SHA-256
  `3dc1965f03f055b88d9718a741a04744377e458e2bfa3f5c1c797f7621281b1e` (computed over the file with
  `status: draft` and empty approval fields). The first approval (`fe8456ac…`) was voided by the
  amendment.
- Environment: WSL2 `6.18.33.2-microsoft-standard-WSL2`, Ubuntu 26.04, Node 22.22.1, npm 9.2.0, GCC
  15.2.0, Clang 21.1.8, 16 CPUs.
- **Status: DONE.** Probes 1, 3, 5 and 11 are stopped on both the `release` and `debug-asan` helper
  builds, with controls. This is not a finished security boundary: see "What a payload can still do".

## What changed

| Area | Files |
| --- | --- |
| Launch-spec protocol | `native/src/spec.{c,h}`, `src/sys/launch-spec.ts`, `native/src/fuzz_spec.c` |
| Cell boot (native) | `native/src/boot.{c,h}`, `native/src/sys.{c,h}` (clone3 args, pidfd_send_signal, pivot_root), `native/src/main.c` |
| Control plane | `src/gateway/request.ts`, `src/launch/{rootfs-plan,run-cell}.ts`, `src/supervise/cell-supervisor.ts`, `src/collect/classify.ts`, `src/sys/status.ts`, `src/util/{tempdir,capped-buffer}.ts`, `src/main.ts` (`aegis run`) |
| Build and CI | `scripts/build-native.mjs` (sources per mode, `fuzz` mode), `scripts/gen-fuzz-seeds.mjs`, `.github/workflows/ci.yml`, `vitest.config.ts` |
| Tests | `tests/unit/{request,launch-spec,status,classify,tempdir,rootfs-plan}.test.ts`, `tests/integration/{run-cell,spec-rejection}.test.ts`, `tests/escape/*`, `tests/helpers/cell.ts`, `tests/fuzz/` |
| Docs | `docs/SETUP-WSL2.md` section 8, `docs/adr/0002-composite-usr-bind.md`, this report |

Size: 1734 lines of C (all of `native/src`), 2081 lines of TypeScript under `src/`.

## How it works (one paragraph)

`aegis run` validates the request with a strict `zod` schema, plans the cell's `/usr` from the host
mount table, encodes a flat launch spec and spawns `aegis-cell boot` with descriptors 3 (spec in),
4 (status out) and 5 (control in) and an empty environment. The helper parses the spec into static
buffers, makes one `clone3` call with eight `CLONE_NEW*` flags and `CLONE_PIDFD`, writes
`setgroups=deny` and the single-id maps for the child, and releases it. The child (PID 1 of the
cell) mounts a size-capped tmpfs root, a fresh `/proc`, the planned read-only binds (each verified
with `statvfs`, then the whole mount table re-read), the device nodes, `/tmp` and a synthetic `/etc`,
compares each namespace inode with the parent's, calls `pivot_root`, and `execve`s the payload with
the spec's environment. Every `layer <name> ok` record is written only after the property was
observed; any failure writes `layer <name> fail <errno>` and exits before `execve`.

## Step 1 spike (measured, before any design depended on it)

Run unprivileged from the scratchpad (outside the repository), kernel
`6.18.33.2-microsoft-standard-WSL2`:

| Hypothesis | Result |
| --- | --- |
| `clone3` accepts all eight `CLONE_NEW*` flags plus `CLONE_PIDFD` | confirmed (`CLONE_NEWTIME` included) |
| Parent can write `setgroups=deny`, `gid_map`, `uid_map` | confirmed (`0 1000 1`) |
| procfs mountable by PID 1 of the new pid namespace before `pivot_root` | confirmed |
| Read-only remount of a bind works if the kernel's locked flags are preserved, and `statvfs` shows it | confirmed (`RDONLY NOSUID NODEV`) |
| `pivot_root`, `umount2(/.old, MNT_DETACH)`, `sethostname` | confirmed |
| A recursive bind of host `/usr` is acceptable | **refuted**: it copies WSL's 9p `drivers` and two overlay mounts (`gpu lib`, `modules`) into the cell; non-recursive bind gives `EINVAL`, unmounting the copies gives `EINVAL`. Led to Amendment 1 and ADR 0002. |
| libFuzzer runtime present | confirmed (`libclang_rt.fuzzer-x86_64.a`) |
| `zod` has no dependencies and no install script | confirmed (4.6.6) |

## Deviations from the prompt

1. **Amendment 1 / ADR 0002**: the cell's `/usr` is a composite of leaf binds planned in TypeScript
   and verified in C, not one recursive bind. Approved by the owner.
2. **`exec_failed` termination cause added** (`src/collect/classify.ts`). The prompt listed five
   causes; a missing or non-executable command is not an isolation failure and reporting it as
   `isolation_unavailable (exec)` would have been misleading. The receipt is complete in that case
   because all layers are built before the final `execve`.
3. **Extra failure-only status layers** (`spec`, `namespaces`, `idmap`, `exec`) beyond the eleven
   receipt layers, so a failure before a layer exists can still be named.
4. **Parser restricts the tree to `/usr`**: native and TypeScript require bind sources, entry
   targets and masks to be `/usr` or below. Added after review as defence in depth (the amendment
   text said sources are validated).
5. **Spike lived in the scratchpad**, so there was nothing to delete from `native/spike/`.
6. **Files not listed in the prompt**: `tests/helpers/cell.ts`, `scripts/gen-fuzz-seeds.mjs`,
   `src/util/capped-buffer.ts` (extracted from `runBounded`, small refactor),
   `tests/integration/spec-rejection.test.ts`, `docs/adr/0002-composite-usr-bind.md`.
7. **`vitest.config.ts` now includes `tests/integration` and `tests/escape`**, so `npm run check`
   runs real cells and needs the helper built first (it fails with a clear message if not).
8. **Bugs found and fixed while verifying** (all before `done`): the exec pipe read as "started"
   after a failed id-map write; a race between poll results and the exec pipe at exit; a fuzz
   harness invariant that was too strict (false positive on a path component containing two
   dots); a test that counted other test files' cell directories (now uses a private parent).

## Results (all measured in this session)

| Gate item | Result |
| --- | --- |
| `npm run check` (tsc, eslint `--max-warnings 0`, prettier, vitest) | **pass**: 18 files, 202 tests (134 unit, 56 integration, 12 escape) |
| Integration and escape tests against `release` (static-pie) and `debug-asan` | pass, both builds. The helper's stderr is the payload's stderr (shared descriptor), so a sanitizer report would appear there; the echo test asserts `stderr === ''` on both builds, other tests do not assert it |
| Native `release` + `debug-asan`, `-Werror`, GCC 15.2.0 | pass |
| Native `release` + `debug-asan`, `-Werror`, Clang 21.1.8 | pass |
| Release helper | `ELF 64-bit LSB pie executable, x86-64, static-pie linked`, `ldd`: statically linked |
| `clang-format --dry-run --Werror`, `clang-tidy` | clean (`{"clangFormat":true,"clangTidy":true}`) |
| Launch-spec fuzz (libFuzzer + ASan + UBSan, `-max_total_time=300 -max_len=70000`) | **130,234,391 executions in 301 s, no crash**, 432,672 exec/s average, coverage 274 edges. Corpus minimised with `-merge=1` and committed (`tests/fuzz/corpus/spec`, 112 files). |
| 1000 near-simultaneous exit/timeout races (`sleep 0.01` vs `wall_ms 40`, 8 concurrent) | 1000 of 1000 classified `exit` (code 0) or `timeout`, none wrong, private temp parent empty afterwards, both builds |
| `npm audit` | 0 vulnerabilities |
| Dependencies | one new runtime dependency, `zod` 4.6.6 (exact pin, 0 dependencies, no install script, `--ignore-scripts`); lockfile 157 packages (+1) |

### Escape probes (harness fixture under a temp directory, CLAUDE.md 6.5)

| Probe | What ran in the cell | Outcome | Control |
| --- | --- | --- | --- |
| 1 `rm -rf /` | `rm -rf --no-preserve-root /`, then of the fixture HOME and project, `cat` of the decoy key | fixture tree byte-identical (sha-256 per file), host `/usr/bin/sh` and `/usr/bin/node` unchanged | inside the cell `test -e <fixture>` is false; decoy key unreadable |
| 3 `/mnt/c` | `ls /mnt/c/Users`, `touch /mnt/c/aegis-probe-3-<pid>`, `ls /mnt` | all fail, `No such file or directory`, no file appears on the host | harness asserts `/mnt/c` exists on the host, else the test fails as inconclusive |
| 5 network | bash `/dev/tcp` connect to `1.1.1.1:443`; connects to the host's default gateway (read from `/proc/net/route`) on ports 53, 445, 135 | all fail (`Network is unreachable`); interfaces are `lo` only; no routes | gateway found on this machine, so the gateway test ran (not skipped) |
| 11 signals | `kill -9 <sentinel pid>`, `kill -TERM <pid>`, `ls /proc/<pid>`, `kill -9 -1` with two background `sleep`s | no such process; both sleeps die (wait status 137); the host sentinel (pid > 1000, owned by the harness) is alive afterwards | sentinel pid not visible in the cell's `/proc` |

None of the four succeeded, so there is no finding to escalate.

### Measured run cost (not a benchmark)

`/usr/bin/true` through `runCell` (plan, spec, spawn, build, run, teardown), 50 runs after 10
warm-up, sequential, idle machine:

| Build | median | p95 | min | max |
| --- | --- | --- | --- | --- |
| release | 8.5 ms | 9.5 ms | 7.7 ms | 10.0 ms |
| debug-asan | 20.1 ms | 21.8 ms | 18.2 ms | 26.7 ms |

## What a payload can still do after this stage

Stated, not hidden (prompt section 4.9); every item has an owning stage.

- It is uid 0 with a full namespace-local capability set (`CapEff 0x1ffffffffff`): it can create
  further namespaces and mount tmpfs/proc/bind mounts inside its own mount namespace. (Stage 4)
- It can read all of the host's `/usr` (read-only, `nosuid,nodev`, verified), including every
  binary and library there. The directories the plan creates empty (`/usr`, `/usr/lib`, ...) are on
  the cell's size-capped tmpfs and are writable inside the cell. (Stage 4 narrows this; a minimal
  root is not part of Stage 1, decision recorded in the prompt.)
- No memory, CPU or process-count limit exists: only the wall-clock timeout and the output cap. A
  fork bomb or an allocation flood is **not** stopped by this stage and was deliberately not run
  here. (Stage 2, cgroups)
- PID 1 of the cell is the payload itself, so it ignores signals sent from inside the cell with the
  default action (`kill -SEGV $$` and `kill -KILL $$` are no-ops, tested) and nothing reaps its
  orphans. A real fault still kills it (tested with a null dereference). (Stage 2, `aegis-cell init`)
- The host user's supplementary groups remain on the process and show up as `65534` inside
  (`setgroups` is denied, so they cannot be dropped). They carry no access to anything in the cell.
- No orphan-cell reaper: if the Node process is killed mid-run the helper's control pipe reaches EOF
  and kills the cell, but an empty `aegis-cell-*` directory under the temp directory can remain.
  (Stage 2)
- Environment and network policy are the fixed Stage 1 ones (`PATH` fixed, loopback down, mode
  `none`); the manifest and ceiling policy are Stage 4.

**Until Stage 4: do not run untrusted code outside the test fixtures.**

## Known limitations and untested paths

- The failed-id-map path (`layer idmap fail`) cannot be induced on this kernel and is covered by
  review only.
- The host `/usr` layout varies; the plan is computed per run and re-verified in the helper, and a
  plan above 512 entries is refused. Only this machine's layout (75 entries) was measured.
- `/tmp` on this machine is a tmpfs; the per-cell directory only holds an empty mountpoint, but
  Stage 3 must re-check xattr support for overlay upper directories there.
- Tests that need `python3` (`ctypes` segfault) or `bash` (`/dev/tcp`) rely on those binaries being
  present in the host's `/usr`.
- CI (`.github/workflows/ci.yml`) was updated but not executed; GitHub's runners may forbid
  unprivileged user namespaces, in which case the integration tests fail loudly by design.

## Commits on `stage/1-core-cell` (base `3b8dcc3`)

See `git log 3b8dcc3..HEAD`; the final commit holds this report and the `done` state, and its parent
is `c0b3027` (`git log -1` on the branch shows the tip).

## Open questions

1. Merging and pushing `stage/0-scaffold` and `stage/1-core-cell` is the owner's decision.
2. Stage 2 needs cgroup delegation (`cgroup.procs` is not writable by the user today); the steps
   belong in `docs/SETUP-WSL2.md` and need the owner's `sudo`.
