---
stage: 2
name: limits-and-receipts
status: approved
created: 2026-10-11
approved_at: 2026-10-11
approved_sha256: d31171cd1a4af06576a40a7b57983bceca7e74e241a26bee04b3c04f9330c6a9
---

# Stage 2: Limits and receipts

## 1. Goal

At the end of this stage every cell runs inside its own cgroup v2 group with enforced memory, pid and CPU limits, `aegis-cell init` is PID 1 of the cell (it starts the payload, forwards signals and reaps every child), every response carries a complete isolation receipt (layers, level, resolved limits, usage numbers, a one-line hint), and the termination classifier reports the full cause set (`exit`, `timeout`, `oom`, `pids_limit`, `output_limit`, `disk_limit`, `signal:<name>`). The fork bomb, the 4 GB allocation, the endless loop, the endless output, the disk fill and the SIGTERM-ignoring zombie maker (probes 7, 8, 9, 10, 17, 18) are each stopped, classified correctly and cleaned up completely. Nothing needs `sudo`.

## 2. Context

- Stage 0 and Stage 1 are done and merged (`main` `e4dc425`). A cell already has eight namespaces, a verified private root and a wall-clock timeout; the payload is its own PID 1 and nothing limits memory, CPU or process count (Stage 1 report, "What a payload can still do").
- Blueprint sections relied on: "Resource control, timeouts and teardown", "Classifying how a run ended", "PID 1 is special: aegis-init", and the isolation receipt (N2, N3).
- **Facts measured on the owner's machine in a read-only look and one self-cleaning spike (kernel `6.18.33.2-microsoft-standard-WSL2`, systemd is PID 1, `systemd=true` in `/etc/wsl.conf`):**
  - `user@1000.service` is a delegated cgroup (`Delegate=yes`, `DelegateControllers=cpu memory pids`), owned by the user, with `cpu memory pids` already enabled in its `subtree_control`. No system change is needed; the blueprint's expectation that `cpu` needs a drop-in does not hold here.
  - Inside `systemd-run --user --scope` the spike created a child cgroup directly under `user@1000.service`, enabled `+cpu +memory +pids` on it, created a leaf, wrote `memory.max`, `memory.swap.max=0`, `memory.oom.group=1`, `pids.max`, `cpu.max`, saw `memory.peak`, `pids.peak`, `cgroup.kill`, `cgroup.events`, `memory.events`, `pids.events`, `cpu.stat`, and `clone3(CLONE_INTO_CGROUP)` succeeded and a process could be moved with `cgroup.procs`.
  - From the owner's normal WSL shell (cgroup `/init.scope`, outside the delegated subtree) the same `clone3(CLONE_INTO_CGROUP)` and the same `cgroup.procs` write fail with `EACCES` (the kernel requires write access to the lowest common ancestor of source and destination). Creating the directories works; placing a process does not.
  - Consequence: **the engine process must itself run inside the delegated subtree**, which `systemd-run --user --scope -- <command>` does without privileges (7 ms measured for `/usr/bin/true`).
- Host memory is 7565 MB, 16 CPUs; `/tmp` is a tmpfs.
- Everything marked **hypothesis** is confirmed or refuted by step 1 (a native spike) before the design depends on it.

## 3. In scope / out of scope

In scope:

- cgroup v2 placement: a per-cell cgroup under a parent the engine creates inside the delegated subtree, controllers enabled on the parent, limits written and **read back**, the helper created inside it with `CLONE_INTO_CGROUP` (so the cell is never outside its limits, not even for an instant).
- `aegis-cell init`: PID 1 supervisor (starts the payload, signal forwarding, reaping, final status), executed from the helper binary bound read-only into the cell root.
- Host-side supervision: kill through `cgroup.kill`, wait for `populated 0`, read counters, remove the cgroup; polling of `pids.events` and `cpu.stat`; wall, CPU and output budgets.
- Classifier with the full cause set, usage numbers, resolved limits and a hint in every response.
- Isolation level and receipt layers (section 4.6), the real cell self-test and cgroup facts in `aegis probe`.
- Disk cap: size-capped tmpfs for `/tmp` (request `disk_mb`), `disk_limit` detection (section 4.7).
- Orphan reaper for cells (cgroups and per-cell directories) at startup.
- `scripts/run-in-scope.mjs` and the `npm test`/`check` wiring so the test suite runs inside a delegated scope.
- Escape probes 7, 8, 9, 10, 17, 18 with controls; tests; sanitizer and fuzz runs.

Out of scope (and the stage that owns it):

- Workspace, overlay, diff, `files`, `fsop`: **Stage 3**.
- Capability drop, `no_new_privs`, seccomp, Landlock, environment policy, manifest and ceiling policy file, loopback, egress, `require` lists: **Stage 4** (limits here are clamped by constants in the request schema).
- Gateway, MCP, broker, automatic re-exec into a scope, a cached probe: **Stage 5**.
- Ablation flags: **Stage 6**. Stage 2 adds no layer-disabling code.

## 4. Design

### 4.1 Where the engine runs, and what happens when it is not in a delegated subtree

The engine finds its own cgroup from `/proc/self/cgroup`, walks up while the directory is owned by the current user, and takes the last such directory as the **delegation root** (here `/user.slice/user-1000.slice/user@1000.service`). It creates `<root>/aegis-cells` once (owner-only, mode 0755 like systemd's own), enables `+cpu +memory +pids` in that directory's `subtree_control` (allowed because it holds no processes), and creates each cell as `<root>/aegis-cells/cell-<pid>-<random>`.

If the engine is **not** inside a delegated subtree (it sits in `/init.scope`, the common case for a plain `wsl.exe` shell), the first create or the `CLONE_INTO_CGROUP` fails closed: the response is `isolation_unavailable` with layer `cgroup_placement`, errno, and the hint `start the engine with: systemd-run --user --scope --quiet --collect -- node dist/main.js run`. The payload never runs and there is no silent fallback to rlimits (the blueprint's "fallback to rlimits only" is rejected: CLAUDE.md 1.2 item 2).

### 4.2 Why a second cgroup level and not the engine's own group

cgroup v2 forbids enabling controllers for children of a group that holds processes. The engine's scope holds Node, so cells live under a process-free parent that the engine creates beside it. The parent is created once and kept; cells are removed after each run.

### 4.3 Limits written and verified

Per cell, all written before the helper is spawned and read back; a value that does not read back equal makes the layer false (and, for memory and pids, aborts the run):

| File | Value | Layer |
| --- | --- | --- |
| `memory.max` | `memory_mb` MiB | `cgroup_memory` |
| `memory.swap.max` | `0` | part of `cgroup_memory` |
| `memory.oom.group` | `1` (kernel kills the whole cell on OOM) | part of `cgroup_memory` |
| `pids.max` | `pids` | `cgroup_pids` |
| `cpu.max` | `<cpu_percent*1000> 100000` | `cgroup_cpu` (reported false when `cpu` is not delegated; not required) |

`cgroup_kill` is true when `cgroup.kill` exists. When it is missing the fallback is to write `SIGKILL` to every pid in `cgroup.procs` until empty, and the receipt says so.

Request limits (all clamped by the schema until Stage 4 has a ceiling file): `memory_mb` 1 to 2048 (default 512), `pids` 1 to 512 (default 128), `cpu_percent` 1 to 400 (default 100), `cpu_ms` 1 to 300000 (CPU-time budget, default 10000), `disk_mb` 1 to 256 (default 16), plus the existing `wall_ms` and `output_kb`.

### 4.4 `aegis-cell init` (PID 1)

`boot`'s child, after `pivot_root`, no longer executes the payload. It `execve`s `/.aegis-init init -- <argv...>` with the payload's environment. `/.aegis-init` is the helper binary itself, bound read-only (`nosuid,nodev`, verified like every other bind, flags preserved) from the path the parent read from `/proc/self/exe` before `clone3`. A fresh exec, not a continuation of the boot process, so init does not carry the launch spec or host paths in memory.

`init`:

1. Refuses to run unless `getpid() == 1` (exit 64), so it is not a usable tool outside a cell.
2. Blocks `SIGCHLD`, `SIGTERM`, `SIGINT`, `SIGHUP`, `SIGQUIT`, `SIGUSR1`, `SIGUSR2` and reads them through a `signalfd`. PID 1 ignores signals with no handler; this is how a SIGTERM from outside is observed and forwarded.
3. Writes `layer init ok`, forks the payload (fresh signal mask, descriptors 0 to 2 only), and learns whether `execve` succeeded through a close-on-exec pipe (EOF = success). It writes `started <pid-in-cell>`, or `layer exec fail <errno>` and exits.
4. Loop: forwarded signals go to the payload; every `SIGCHLD` is followed by `waitpid(-1, WNOHANG)` until `ECHILD`, so orphans reparented to PID 1 are reaped.
5. When the payload is reaped it writes `exited <code>` or `signaled <signo>`, then `full <path>` for each of `/`, `/tmp`, `/dev/shm` whose free blocks are zero (`statvfs`), sends `SIGKILL` to everything else in the cell (`kill(-1, SIGKILL)`), reaps until `ECHILD`, and exits 0.

Trust statement (to be repeated in the report): until Stage 4 the payload holds `CAP_SYS_PTRACE` in the cell's user namespace and can read init's descriptors through `/proc/1/fd`. The records init writes are therefore **forgeable by the payload about its own outcome** until capabilities are dropped. Everything the engine uses to classify a *limit* (`memory.events`, `pids.events`, `cpu.stat`, `cgroup.events`, the supervisor's own timers) is read by the host from the cgroup and cannot be forged.

### 4.5 Supervision and teardown (host side, one event loop)

- The per-cell cgroup directory is opened by the control plane and passed as descriptor 6; the helper sets `CLONE_INTO_CGROUP` and `cgroup = fd 6`. Descriptor 6 is close-on-exec and closed before any payload code.
- The supervisor starts timers and polls every 25 ms: `pids.events` (`max` counter > 0 means forks failed), `cpu.stat` (`usage_usec` against the CPU budget) and `memory.events` (`oom_kill` > 0).
- **Kill procedure** (any trigger: wall timeout, CPU budget, output cap, `pids.max` hit, helper EOF): record the cause, write `1` to `cgroup.kill`, send `K` to the helper (kept as a backstop), wait for `populated 0` in `cgroup.events` (poll, 5 s cap), then read `memory.peak`, `memory.events`, `pids.events`, `pids.peak`, `cpu.stat`, then `rmdir` the cell cgroup, then the cell directory. A cgroup that will not empty within the cap is reported as `internal_error` with a leak warning and left for the reaper; it is never deleted by force.
- A `pids.max` hit is a kill trigger (cause `pids_limit`), as the blueprint's cause table implies; the payload does not get to spin on a failing `fork`.
- Guaranteed teardown on the host side is a disposable guard (`await using`), as in CLAUDE.md 5.1; the reaper (4.8) covers crashes.

### 4.6 Classification, receipt and level

Precedence: `isolation_unavailable` (no payload ran) > `exec_failed` > a **supervisor-initiated** kill (`timeout` with `clock: "wall" | "cpu"`, `output_limit`, `pids_limit`) > `oom` (`memory.events` `oom_kill` increased) > `disk_limit` (init reported a full capped tmpfs and the payload did not exit 0) > `signal:<NAME>` > `exit`. The response also lists every limit that was hit (`limits_hit`) so a kill by one cause is not hiding another.

Response additions:

```json
{ "termination": { "cause": "oom" },
  "usage": { "wall_ms": 412, "cpu_ms": 380, "memory_peak_bytes": 536870912, "pids_peak": 3 },
  "limits": { "memory_mb": 512, "pids": 128, "cpu_percent": 100, "cpu_ms": 10000,
              "wall_ms": 10000, "output_kb": 256, "disk_mb": 16 },
  "limits_hit": ["memory"],
  "hint": "killed at the 512 MB memory limit; reduce the working set or ask for a higher limit",
  "isolation": { "level": 2,
    "layers": { "userns": true, "pidns": true, "mountns": true, "netns": true, "ipcns": true,
                "utsns": true, "cgroupns": true, "timens": true, "root": true, "proc": true,
                "dev": true, "init": true, "cgroup_memory": true, "cgroup_pids": true,
                "cgroup_cpu": true, "cgroup_kill": true } } }
```

Level (deterministic, defined in ADR 0003, extended by later stages): tier 1 = `userns pidns mountns netns root proc dev`; tier 2 = tier 1 plus `ipcns utsns cgroupns timens init cgroup_memory cgroup_pids`; tier 3 = overlay workspace (Stage 3); tier 4 = capability drop, `no_new_privs`, seccomp (Stage 4). The level is the number of consecutive tiers whose layers are all true; Stage 2 can reach 2. `cgroup_cpu` and `cgroup_kill` are reported but not part of a tier (blueprint: CPU is optional). Every layer value is built from records the helper or the control plane produced after observing the property, never from configuration.

### 4.7 Disk cap

The disk a payload can write is the cell's tmpfs mounts: `/` (64 MiB), `/tmp` (`disk_mb`), `/dev/shm` (1 MiB). Their size is the cap, and tmpfs pages are charged to the cell's memory cgroup, so a disk fill is also bounded by `memory.max`. `disk_limit` is detected by init (4.4 step 5) and is a heuristic by design: "a capped tmpfs was full when the payload ended and it did not exit 0". It is documented as such in the receipt hint. A payload that is killed for another reason before it ends is classified by that reason.

### 4.8 Orphan reaper

At the start of every `aegis run`, and in `aegis probe`: for each `<root>/aegis-cells/cell-<pid>-*` whose pid is not alive, write `cgroup.kill`, wait for empty (2 s cap), `rmdir`; for each `aegis-cell-<pid>-*` temp directory under the temp directory whose pid is not alive and which is empty, `rmdir`. A live pid is never touched. Never recursive deletion (CLAUDE.md 6.3 spirit; same rule as `TempDir`).

### 4.9 `aegis probe` and the receipt

`aegis probe` keeps Stage 0's raw facts and adds: the delegation root and whether the engine is inside it; controllers enabled; `cgroup.kill`, `memory.peak`, `pids.peak` presence; whether a cell cgroup can be created and a helper placed into it; and the result of a **real self-test cell** (`/usr/bin/true`) with the per-layer receipt and the computed level. There is no cache in this stage: every run builds its own receipt from what the helper and cgroup actually did, which is stronger than a cached probe.

### 4.10 The five contributions

1. Diff-then-commit: untouched (Stage 3).
2. Fail-closed receipts: completed for the Stage 2 layers (4.1, 4.3, 4.6); a missing delegated cgroup refuses the run.
3. Termination causes: full cause set, from kernel counters and supervisor flags (4.6).
4. Manifests: still schema bounds only (Stage 4).
5. Escape corpus: probes 7, 8, 9, 10, 17, 18 added, with controls.

## 5. Files

New TypeScript (about 900 lines, tests excluded): `src/launch/cgroup.ts` (location, parent creation, `CellCgroup` guard, limit write and read-back, kill, wait, stats, reaper), `src/probe/isolation.ts` (tiers and level), `scripts/run-in-scope.mjs`.

New native (about 400 lines of C): `native/src/init.c`, `native/src/init.h`.

New tests: `tests/unit/{cgroup,isolation}.test.ts`, `tests/integration/{limits,init}.test.ts`, `tests/escape/{probe-07-fork-bomb,probe-08-memory,probe-09-cpu-spin,probe-10-output,probe-17-disk-fill,probe-18-pid1-zombies}.test.ts`.

Modified: `native/src/boot.c` (`CLONE_INTO_CGROUP`, helper bind, exec of init, descriptor 6), `native/src/spec.{c,h}` (one flag record saying a cgroup descriptor is passed; the helper's own path comes from `/proc/self/exe`, not from the spec), `native/src/main.c` (`init`), `src/sys/launch-spec.ts`, `src/sys/status.ts` (records `full`, layer `init`), `src/launch/run-cell.ts`, `src/supervise/cell-supervisor.ts`, `src/collect/classify.ts`, `src/gateway/request.ts`, `src/probe/probe.ts`, `src/main.ts`, `scripts/build-native.mjs` (source list), `package.json` (`test` through `run-in-scope`), `.github/workflows/ci.yml`, `docs/SETUP-WSL2.md`, `docs/STAGES.md`, `docs/reports/stage-2.md`, `docs/adr/0003-isolation-levels-and-cgroup-placement.md`, `tests/integration/run-cell.test.ts` (root listing now includes `.aegis-init`).

## 6. Dependencies and privileged actions

- New npm packages: **none**. New native libraries: none.
- Packages the owner must install: none.
- Privileged actions: **None.** No `sudo`, no `wsl.conf`, no systemd drop-in, no cgroup ownership change: the delegated subtree already exists and is owned by the user. The engine creates and removes directories only below `user@1000.service/aegis-cells`.
- One operational change for the owner: start the engine (and run the tests) through `systemd-run --user --scope`. `npm run check` does this itself via `scripts/run-in-scope.mjs`.

## 7. Step-by-step plan

1. **Spike (native, in the scratchpad, outside the repository):** confirm in a real cell that (a) a bind of `/proc/self/exe` to a file in the new root is executable after `pivot_root` with `nosuid,nodev,ro` for both the static `release` helper and the dynamic `debug-asan` helper (shared libraries found without an `ld.so.cache`); (b) `signalfd` and `waitpid(-1)` behave as designed for PID 1 of a pid namespace; (c) writes to `cgroup.kill` from the host kill a cell started with `CLONE_INTO_CGROUP`; (d) `cgroup.events` reaches `populated 0` and `rmdir` then succeeds. **If any hypothesis fails, stop and amend this prompt** (CLAUDE.md 0.5).
2. `cgroup.ts`: location detection, parent creation, limit write and read-back, kill, wait, stats, reaper; unit tests over an injected filesystem.
3. Classifier, level, request limits, status records (pure logic) with unit and property tests.
4. Native: descriptor 6 and `CLONE_INTO_CGROUP` in `boot`; helper bind; exec of init.
5. Native: `init`.
6. Supervisor: polls, kill procedure, teardown, stats; `run-cell` wiring; `aegis run` and `aegis probe` output.
7. `run-in-scope.mjs` and npm script wiring; CI and setup guide.
8. Integration tests (limits applied, init behaviours, teardown, reaper); then escape probes 7, 8, 9, 10, 17, 18.
9. `npm run check`, GCC and Clang builds of `release` and `debug-asan`, `clang-tidy`, `clang-format`, fuzz re-run of the spec parser, measured run cost, report, `docs/STAGES.md`.
10. Commit incrementally on `stage/2-limits-and-receipts` (created at approval from `main`); the last commit holds the report and `done`.

## 8. Tests and acceptance gate

**Unit and property:** cgroup location from sample `/proc/self/cgroup` and ownership maps (inside, outside, no delegation); limit write/read-back mismatch handling; classifier table over every precedence pair; level computation (monotone: removing a layer never raises the level); request limit bounds (fast-check); status guard with the new records.

**Integration (`needs_userns` and `needs_cgroup`; a missing feature fails with the layer and errno in the message, never silently skipped):**

- Limits are applied and read back: the response's `limits` equal the written values; `cat /proc/self/cgroup` in the cell is `0::/` (cgroup namespace root is the cell cgroup).
- The helper starts inside the cell cgroup: `memory.peak` of that cgroup is non-zero after a run and `cgroup.procs` of the parent is empty afterwards.
- Init: `pid 1` is `/.aegis-init`; the payload is pid 2; zombies from orphaned grandchildren are reaped (no `Z` state after a short sleep); a SIGTERM from the supervisor is forwarded; `kill -9 1` from the payload is ignored; payload exit codes and signal deaths are reported as in Stage 1.
- Teardown: after every termination cause the cell cgroup directory and the per-cell directory are gone (private parent directories as in Stage 1), `cgroup.events` `populated 0` was observed, and no `aegis-cell` process remains.
- Outside a delegated subtree: running the same request from a process placed in `/init.scope` (the test spawns the CLI through a helper that is not in a scope) returns `isolation_unavailable` with layer `cgroup_placement` and the hint, and the payload marker is absent.
- Reaper: a cell cgroup and a temp directory left by a dead pid are removed; those of a live pid are untouched.
- Receipt: present in every response including refusals; `level` is 2 on a healthy run and the layer values match what happened.

**Escape probes (disposable fixture; CLAUDE.md 6.5: fork bomb and memory probes run only when the harness has verified `cgroup_pids` and `cgroup_memory` are active in a self-test cell, otherwise the test fails as inconclusive):**

| Probe | Payload | Pass condition | Layer expected to stop it |
| --- | --- | --- | --- |
| 7 fork bomb | `:(){ :\|: & };:` with default limits | `pids_limit` within the wall budget, `pids_peak` ≤ `pids`, host process count back to baseline, cell cgroup gone | cgroup pids |
| 8 allocate 4 GB | `python3` allocating and touching 4 GiB | `oom`, `memory_peak_bytes` ≤ limit + small tolerance, host available memory not reduced afterwards | cgroup memory (`memory.oom.group`) |
| 9 spin 60 s | `while True: pass` with `wall_ms 60000`, `cpu_ms 2000` | `timeout` with `clock: "cpu"` in about 2 s, not 60 s | CPU budget (cpu.stat) |
| 10 endless output | `yes` | `output_limit`, captured bytes ≤ cap, full receipt present | output cap |
| 17 disk fill | `dd if=/dev/zero of=/tmp/fill bs=1M` | `disk_limit`; the host's free disk and the temp directory are unchanged | size-capped tmpfs |
| 18 PID 1 / zombies | payload ignores `SIGTERM` and `SIGINT`, forks children that exit and orphans that outlive it, `wall_ms 500` | `timeout`, all processes gone, no zombie ever visible to the payload, cgroup and directories removed | init + `cgroup.kill` |

A probe that succeeds against the full stack is a **finding**: reported prominently and the stage stops (CLAUDE.md 7).

**Sanitizers and fuzzing:** integration and escape suites against both helper builds (init runs from the same binary, so `debug-asan` covers it); the launch-spec fuzz target is rebuilt and run again for at least 5 minutes with no crash if the parser changes.

**Definition of done** (CLAUDE.md 0.6): everything above measured and recorded; `npm run check` green; native checks clean; `docs/reports/stage-2.md` with commands, measured numbers (per-probe time to termination, peak memory, run cost with cgroup and init versus Stage 1's 8.5 ms median), deviations, limitations, branch and final commit; `docs/STAGES.md` `done`; everything committed on `stage/2-limits-and-receipts` with a clean tree. Nothing pushed or merged by Claude.

## 9. Risks and mitigations

- **Engine not inside the delegated subtree** (the common case in a plain shell): fails closed with an actionable hint (4.1); `npm run check` self-wraps; documented in the setup guide. Auto re-exec is deferred (section 11, item 1).
- **Controllers not delegated on another machine** (`cpu` missing): `cgroup_cpu` false and reported; memory and pids missing refuses the run.
- **`CLONE_INTO_CGROUP` or `cgroup.kill` missing on an older kernel**: refused or falling back to per-pid kill, receipt says which (4.3).
- **Dynamic `debug-asan` init inside the cell** needs its shared libraries from the bound `/usr`; step 1 checks this first. If it fails the fallback is to run the sanitizer build's init from a statically linked sanitizer runtime or to test init only on `release`; either is a recorded deviation, not a silent one.
- **Forgeable init records** (4.4): stated, bounded by classifying limits from kernel counters only, closed by Stage 4.
- **Race: kill versus natural exit**: the cause is decided by flags set before the kill and counters read after `populated 0`; the Stage 1 race loop is repeated with the cgroup path (1000 iterations).
- **A fork bomb or allocation flood outrunning the poll**: the kernel limits are the enforcement; polling only adds the kill and the cause. Probes 7 and 8 run only after the self-test confirmed the limits are active.
- **Leaked cgroups**: removal only by `rmdir` of an empty group; a group that will not empty is reported and left for the reaper; no recursive or forced deletion.
- **systemd interference**: the parent lives under the delegated `user@1000.service`, which systemd does not manage because of `Delegate=yes`; the unit's own scope is untouched.

## 10. Rollback

All work is on branch `stage/2-limits-and-receipts`; back out by deleting the branch or `git revert`. Runtime state: cgroups under `user@1000.service/aegis-cells` and temp directories `aegis-cell-*`; both are removed by the reaper or by hand (`rmdir` of empty directories; `echo 1 > cgroup.kill` first if populated). No system files are changed.

## 11. Open questions for the owner

1. **How the engine gets into the delegated subtree.** Recommended: explicit, documented `systemd-run --user --scope -- node dist/main.js ...` (and `scripts/run-in-scope.mjs` for the tests), refusing with a hint otherwise. Alternative: `aegis run` re-executes itself through `systemd-run` automatically. The alternative changes the process tree and is better decided with the Stage 5 MCP launch. Recommended: explicit now.
2. **Default and maximum limits** (4.3): memory 512 MiB (max 2048), pids 128 (max 512), CPU 100 % of one core, CPU budget 10 s, disk 16 MiB (max 256), wall 10 s (max 60 s). Acceptable until the Stage 4 ceiling file exists?
3. **Kill on the first `pids.max` hit** (cause `pids_limit`), rather than letting a payload keep running with failing forks. Recommended: kill.
4. **`disk_limit` heuristic** (4.7: a capped tmpfs full at the payload's end and non-zero exit). Acceptable, or should the supervisor kill as soon as any capped tmpfs is full (needs init to poll)?
5. **Level definition** (4.6, ADR 0003): tiers 1 to 4 as stated, level = consecutive satisfied tiers. Acceptable?
6. **Running destructive resource probes on this machine.** The fork bomb and 4 GB allocation run only after the self-test proves the limits are active, inside cgroups with `pids.max` and `memory.max` set, on a host with 7.5 GB of RAM. Confirm this is acceptable on your machine (CLAUDE.md 6.5 asks for either the active cgroup layer or a disposable distribution).
