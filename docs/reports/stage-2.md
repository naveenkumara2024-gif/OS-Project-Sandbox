# Stage 2 report: Limits and receipts

- Branch: `stage/2-limits-and-receipts`, created from `main` at `e4dc425` (Stage 0 and Stage 1
  merged). Nothing pushed or merged by Claude.
- Prompt: `docs/prompts/stage-2-limits-and-receipts.md`, approved 2026-10-11, SHA-256
  `d31171cd1a4af06576a40a7b57983bceca7e74e241a26bee04b3c04f9330c6a9` (computed over the file with
  `status: draft` and empty approval fields). No amendment was needed.
- Environment: WSL2 `6.18.33.2-microsoft-standard-WSL2`, Ubuntu 26.04, systemd PID 1, Node
  22.22.1, GCC 15.2.0, Clang 21.1.8, 16 CPUs, 7565 MB RAM.
- **Status: DONE.** Probes 7, 8, 9, 10, 17 and 18 are stopped, classified correctly and cleaned up
  on both the `release` and `debug-asan` helper builds. Every response, including refusals,
  carries a receipt. No `sudo`, no system file, no new npm dependency.
- This is still not a finished security boundary: capabilities are not dropped until Stage 4, see
  "What a payload can still do".

## What changed

| Area | Files |
| --- | --- |
| `aegis-cell init` (PID 1) | `native/src/init.{c,h}`, `native/src/main.c` |
| Placement and teardown (native) | `native/src/boot.c` (`CLONE_INTO_CGROUP`, helper bound into the root, exec of init), `native/src/spec.{c,h}` (cgroup-fd record), `native/src/sys.h` |
| cgroup management | `src/launch/cgroup.ts` (location, parent, `CellCgroup`, counters, reaper) |
| Receipt and level | `src/probe/isolation.ts`, `src/probe/isolation-probe.ts`, `src/launch/run-cell.ts` |
| Classifier | `src/collect/classify.ts` (full cause set, hints) |
| Supervision | `src/supervise/cell-supervisor.ts` (polls, `cgroup.kill`, cgroup descriptor) |
| Request and protocol | `src/gateway/request.ts` (limits), `src/sys/launch-spec.ts`, `src/sys/status.ts` |
| CLI and tooling | `src/main.ts` (reaper, probe), `src/util/tempdir.ts` (stale dirs), `scripts/run-in-scope.mjs`, `package.json`, `scripts/build-native.mjs` |
| Tests | `tests/unit/{cgroup,isolation,classify,...}`, `tests/integration/{limits,init,...}`, `tests/escape/probe-{07,08,09,10,17,18}-*`, `tests/helpers/cell.ts` |
| Docs | `docs/SETUP-WSL2.md` section 9, `docs/adr/0003-isolation-levels-and-cgroup-placement.md`, `.github/workflows/ci.yml`, this report |

Size: 2027 lines of C under `native/src`, 3162 lines of TypeScript under `src/`.

## How it works (one paragraph)

The engine finds the cgroup it runs in and walks up while the directories are owned by the user
(here `user@1000.service`). Below that it keeps a process-free `aegis-cells` parent with
`+cpu +memory +pids` enabled and makes one leaf per cell, writing `memory.max`,
`memory.swap.max=0`, `memory.oom.group=1`, `pids.max` and `cpu.max` and reading each back. The
leaf's directory descriptor goes to the helper as descriptor 6 and `clone3` uses
`CLONE_INTO_CGROUP`, so the cell never exists outside its limits. After `pivot_root` the helper
`execve`s a read-only bind of itself as `/.aegis-init`: init blocks the catchable signals and reads
them through a `signalfd`, forks the payload, forwards signals, reaps everything reparented to
PID 1, reports `started`/`exited`/`signaled`/`full <tmpfs>`, then kills and reaps what is left. On
the host a 25 ms poll watches `pids.events` and `cpu.stat`; any end of the run writes
`cgroup.kill`, waits for `populated 0`, reads `memory.peak`, `memory.events`, `pids.events`,
`pids.peak` and `cpu.stat`, and removes the cgroup with `rmdir`. The classifier fuses the
supervisor's own flags with those counters and the response carries limits, usage, hint and the
level.

## Measured before the design depended on it

A read-only look and a self-cleaning spike (kernel `6.18.33.2-microsoft-standard-WSL2`) before the
prompt was drafted, then step 1's spike after approval (both outside the repository):

| Hypothesis | Result |
| --- | --- |
| `user@1000.service` delegates controllers to the user without `sudo` | confirmed: `Delegate=yes`, `cpu memory pids`, owned by the user |
| `CLONE_INTO_CGROUP` works from a user scope | confirmed |
| `CLONE_INTO_CGROUP` and a `cgroup.procs` write from `/init.scope` | **refused with EACCES** (common-ancestor rule), so the engine must run in a scope |
| Exec of a read-only bind of `/proc/self/exe` after `pivot_root` | confirmed for the static-pie build and for the dynamic ASan build (shared libraries found with no `ld.so.cache`) |
| `signalfd` and `waitpid(-1)` as PID 1; orphans reaped | confirmed (2 orphans reaped before the payload) |
| Host `cgroup.kill` ends a populated cell, `populated 0` follows, `rmdir` works | confirmed: 5 ms from write to `populated 0` |

## Deviations from the prompt

1. **Kernel-level `EACCES` is tested through the root cgroup, not a process in `/init.scope`.** A
   test running inside a scope cannot spawn a process outside it. Coverage: the control plane's
   ownership check is tested with an injected `/proc/self/cgroup` text (`/init.scope`) and the
   helper's mapping of the kernel's `EACCES` to `cgroup_placement` is tested by handing it the root
   cgroup directory (not writable by the user). The real plain-shell case was run by hand and gave
   `isolation_unavailable`, layer `cgroup_placement`, errno 13, level 0, with the hint.
2. **Extra status records**: `cellexit`/`cellsig` (PID 1's wait status as seen from outside the cell,
   not forgeable by the payload) and `full <path>`; `started` is now written by init, not by the
   helper's parent, and the failure-only layers `cgroup_placement` and `cgroup_limits` exist.
3. **Two classifier rules added after races showed up in the repeat runs** (both found by the
   tests, both fixed before `done`): a supervisor kill by timeout during setup is a `timeout`, not
   `isolation_unavailable`; and an output or pids kill is a payload outcome even if init was killed
   before it wrote `started`.
4. **Signal aliases** (`SIGABRT`/`SIGIOT`, `SIGCHLD`/`SIGCLD`, `SIGIO`/`SIGPOLL`) resolve to the
   familiar name; a hint reading "SIGIOT" for an abort was wrong in spirit.
5. **Files not listed in the prompt**: `src/probe/isolation-probe.ts`, `tests/unit/isolation.test.ts`
   additions, `withPrivateParent` and `runWith`/`requireCgroupLimits` in `tests/helpers/cell.ts`, and
   `native/src/fuzz_spec.c` invariants for the new record.
6. **`npm test` is `node scripts/run-in-scope.mjs vitest run`**, so `npm run check` needs
   `systemd-run`; `AEGIS_NO_SCOPE=1` bypasses it.
7. **Probe payloads**: Ubuntu 26.04 ships a Rust `dd` whose error text and summary differ from GNU
   `dd`, so probe 17 measures the bytes that landed with `wc -c`; probe 7's payload stays alive
   after starting the bomb (a payload that exits ends the cell at once, which is correct but does
   not exercise the limit).
8. **Test hygiene problems of mine, fixed**: a fork-bomb check that counted other test files'
   processes, a `; `-joined shell script with `&;`, and cleanup that did not run when an assertion
   threw. Each was a test defect, none a product defect.

## Results (all measured in this session)

| Gate item | Result |
| --- | --- |
| `npm run check` (tsc, eslint `--max-warnings 0`, prettier, vitest) | **pass**: 28 files, 268 tests (159 unit, 79 integration, 30 escape) |
| Stability | full suite 3 consecutive runs and the escape suite 12 consecutive runs, no failure, after the two classifier races were fixed |
| Both helper builds | integration and escape suites run against `release` (static-pie) and `debug-asan` (ASan + UBSan); init runs from the same binary, so it is covered |
| Native `release` + `debug-asan`, `-Werror`, GCC 15.2.0 and Clang 21.1.8 | pass |
| `clang-format --dry-run`, `clang-tidy` | clean |
| Launch-spec fuzz (libFuzzer + ASan + UBSan, `-max_total_time=300`) | **145,288,926 executions in 301 s, no crash**, 482,687 exec/s, 282 coverage edges; minimised corpus committed |
| 1000 near-simultaneous exit/timeout races through the cgroup path | 1000 of 1000 `exit` or `timeout`, none wrong, private parent empty afterwards, both builds |
| Leftovers after the whole suite | 0 cell cgroups under `aegis-cells`, 0 temp directories |
| `npm audit` | 0 vulnerabilities; no dependency added |

### Escape probes

Fork-bomb and memory probes ran only after a self-test cell proved `cgroup_memory` and
`cgroup_pids` were active (CLAUDE.md 6.5). One run each through the real engine, `release` build:

| Probe | Cause | Time to end | Numbers | Control |
| --- | --- | --- | --- | --- |
| 7 fork bomb (`pids` 64) | `pids_limit` | 44 ms | `pids_peak` 64, memory peak 13 MB | no process of the worker's cells remains, cgroup removed |
| 8 allocate 4 GB (`memory_mb` 256) | `oom` | 183 ms | memory peak 256 MB (the limit), `limits_hit` memory | the 4 GB message never printed; host `MemAvailable` did not drop by 300 MB |
| 9 `while True: pass`, wall 60 s | `timeout`, clock `cpu` | 1517 ms | `cpu_ms` 1507 against a 1500 ms budget | a generous CPU budget with a sleeping payload ends on the wall clock instead (`clock: wall`) |
| 10 endless output (`output_kb` 64) | `output_limit` (stdout) | 14 ms | captured bytes at most the cap | full 16-layer receipt, level 2 |
| 17 dd fill (`disk_mb` 8) | `disk_limit` (`/tmp`) | 20 ms | bytes landed between 4 and 8 MiB; dd exit 1, "No space left on device" | host temp directory free space unchanged |
| 18 ignore TERM/INT, orphans | `timeout`, clock `wall` | 706 ms (limit 700) | payload printed `still-here` after `kill -TERM $$` | per-cell directory and cgroup removed |

None of the six escaped, so there is no finding to escalate.

### Measured run cost (not a benchmark)

`/usr/bin/true` through `runCell` (plan, cgroup, spec, spawn, build, init, run, teardown), 50 runs
after 10 warm-up, sequential:

| Build | median | p95 | min | max | Stage 1 median (no cgroup, no init) |
| --- | --- | --- | --- | --- | --- |
| release | 9.8 ms | 10.5 ms | 9.1 ms | 12.6 ms | 8.5 ms |
| debug-asan | 33.1 ms | 34.2 ms | 30.8 ms | 34.9 ms | 20.1 ms |

## What a payload can still do after this stage

Stated, not hidden; every item has an owning stage.

- It is uid 0 with a full namespace-local capability set and can read all of the host's `/usr`
  read-only. (Stage 4)
- **Init's records are forgeable by the payload about its own outcome** until capabilities are
  dropped: it holds `CAP_SYS_PTRACE` in the cell's user namespace and can reach init's
  descriptors through `/proc/1/fd`. What the engine uses to classify a *limit* (`memory.events`,
  `pids.events`, `cpu.stat`, `cgroup.events`, the supervisor's timers) and PID 1's own wait status
  (`cellexit`/`cellsig`) is read from outside and cannot be forged. (Stage 4)
- `disk_limit` is a heuristic by design: a capped tmpfs was full when the payload ended and it did
  not exit 0. A payload killed for another reason first is classified by that reason.
- tmpfs pages are charged to the cell's memory cgroup, so `/tmp` space and process memory share
  `memory_mb`.
- The network is still only "no interfaces" (Stage 4 owns egress policy); there is no
  `no_new_privs`, seccomp or Landlock yet.

## Known limitations and untested paths

- **The engine must be started inside a delegated subtree** (`systemd-run --user --scope`).
  `aegis run` from a plain shell is refused with a hint rather than weakened; automatic re-exec is
  deferred to Stage 5. CI runners without a systemd user manager will fail the integration tests
  by design; `.github/workflows/ci.yml` was updated and not executed.
- A PID reused by an unrelated process makes the reaper skip a dead engine's cell until that PID
  dies; it never touches a live PID.
- Only this machine's cgroup layout was measured (`cpu memory pids` delegated). A machine without
  `cpu` is handled (`cgroup_cpu` false) but untested; one without `memory` or `pids` refuses.
- The per-pid kill fallback for a kernel without `cgroup.kill` is implemented and unit-reachable but
  was not run (this kernel has `cgroup.kill`).
- The helper's `idmap` failure path still cannot be induced on this kernel (as in Stage 1).

## Commits on `stage/2-limits-and-receipts` (base `e4dc425`)

See `git log e4dc425..HEAD`; the final commit holds this report and the `done` state, and its parent
is `f4cd770` (`git log -1` on the branch shows the tip).

## Open questions

1. Merging and pushing `stage/2-limits-and-receipts` is the owner's decision.
2. Whether `aegis run`/`aegis mcp` should re-execute themselves into a scope automatically is
   deferred to the Stage 5 MCP launch (prompt section 11 item 1).
