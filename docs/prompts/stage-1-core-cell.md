---
stage: 1
name: core-cell
status: draft
created: 2026-10-11
approved_at:
approved_sha256:
---

# Stage 1: Core cell

## 1. Goal

At the end of this stage `aegis run` takes a JSON request (a command, an environment and two limits), starts the command inside a throwaway **cell** and prints a JSON result: stdout, stderr, exit code, why the run ended (`exit`, `timeout`, `signal:<name>`) and which namespace and filesystem layers the helper actually established. The cell has its own user, pid, mount, network, ipc, uts, cgroup and time namespaces and a private root (a fresh tmpfs with read-only bind mounts, a fresh `/proc`, a minimal `/dev`) entered with `pivot_root`. A wall-clock timeout kills the whole cell through a `pidfd`. Escape probes 1, 3, 5 and 11 are stopped and proven by tests against a disposable fixture. Nothing here is a finished security boundary: capability drop, seccomp, Landlock and cgroup limits arrive in Stages 2 and 4, and section 4.9 says exactly what a payload can still do.

## 2. Context

- Blueprint sections relied on: "How one request runs" steps 5 to 12, "The eight namespaces", "The minimal root", and phase 1 of the roadmap (`docs/AegisEngine R and D Blueprint.docx`). Deviations from the blueprint's shell-script boot are already covered by ADR 0001 (native helper, no `systemd-run`, no `unshare(1)`).
- Stage 0 is done and merged (`main` `c2c0c4d`; documentation fix `3b8dcc3` is on `stage/0-scaffold` and not in `main`, see section 11 item 1). `Result`, `OwnedFd`, `runBounded`, procfs parsers, the helper client and `sys.c` wrappers exist.
- Facts from the Stage 0 probe on the owner's machine (kernel `6.18.33.2-microsoft-standard-WSL2`, Node `22.22.1`): `unshare(CLONE_NEWUSER)` works, `clone3` is reachable, `pidfd_open` works, `openat2` `RESOLVE_BENEATH` works, Landlock ABI 7, `cgroup.kill` exists, `/proc/sys/user/max_user_namespaces` 30219, `overlay` listed. cgroup placement is **not** possible yet (`cgroup.procs` not writable); that is why cgroups are Stage 2.
- Host facts that shape this stage: `/bin`, `/lib`, `/lib64`, `/sbin` are symlinks into `/usr` (merged-usr); `/tmp` is a tmpfs; `/usr/bin/node` and `/usr/include/node` exist on the host; `/usr/bin/{sh,bash,python3,env,sleep}` exist.
- Everything marked **hypothesis** below is confirmed or refuted by step 1 (a native spike) before any design depends on it.

## 3. In scope / out of scope

In scope:

- Launch-spec protocol: TypeScript encoder (`src/sys/launch-spec.ts`), native parser (`native/src/spec.c`), hard size cap, version field, unknown keys rejected, libFuzzer target for the parser.
- `aegis-cell boot`: `clone3` with `CLONE_NEWUSER | NEWPID | NEWNS | NEWNET | NEWIPC | NEWUTS | NEWCGROUP | NEWTIME | CLONE_PIDFD`, id maps written by the parent, private tmpfs root, read-only binds, `/proc`, `/dev`, `pivot_root`, hostname, `exec` of the payload as PID 1 of the cell, status stream, `pidfd` kill on request.
- `aegis run`: request schema (`zod`), per-cell temporary directory guard, spawn of the helper with explicit descriptors, bounded stdout/stderr, wall-clock timer, result JSON including the layers the helper reports.
- Fail closed: any layer that cannot be established aborts the cell before the payload executes and yields `isolation_unavailable` naming the layer.
- Tests: unit, property, integration (`needs_userns`), escape probes 1, 3, 5, 11 through a harness, ASan/UBSan runs, native fuzz target.

Out of scope (and the stage that owns it):

- cgroup v2 limits, `CLONE_INTO_CGROUP`, `aegis-cell init` as PID 1 (zombie reaping, signal forwarding), full startup probe and complete receipt, full termination classifier (`oom`, `pids_limit`, `output_limit`, `disk_limit`), disk caps, orphan-cell reaper: **Stage 2**.
- Workspace, files in the request, overlay, diff, commit, `fsop`, `rsync`: **Stage 3**.
- Capability drop, `no_new_privs`, seccomp, Landlock, environment policy beyond the name/size rules here, manifest and ceiling policy, loopback bring-up, egress: **Stage 4** (network mode is `none` only in this stage).
- Gateway, MCP, broker, Jazzer.js fuzzing of TypeScript parsers: **Stage 5** (see section 11 item 4).
- Ablation flags (`AEGIS_ENABLE_ABLATION`): **Stage 6**. Stage 1 adds no layer-disabling code.

## 4. Design

### 4.1 Process model

```
aegis run (Node, multithreaded, host)          never creates namespaces (CLAUDE.md 5.2)
  └─ spawn aegis-cell boot            fresh single-threaded process, explicit argv/env/stdio
       ├─ parse launch spec (fd 3) into static buffers
       ├─ clone3(NEW* flags, CLONE_PIDFD) → child = PID 1 of the cell, parent holds pidfd
       ├─ parent: write setgroups=deny, gid_map, uid_map for the child, then release it (sync pipe)
       ├─ child: build root, pivot_root, set hostname, close fds, execve(payload)
       └─ parent: wait for child exit or a control message; report status on fd 4
```

Why not `unshare(1)`/shell: ADR 0001, CLAUDE.md 6.2. Why a parent that stays alive: `clone3` with `CLONE_NEWPID` makes the child PID 1 of a new pid namespace, and the id maps of a new user namespace can only be written from outside it, so a live parent is required for both. Why the payload is PID 1 for now: `aegis-cell init` is Stage 2; until then the payload as PID 1 gives the property we need (when PID 1 dies the kernel kills every process in the namespace, so no stragglers) and `SIGKILL` from the parent namespace still works.

### 4.2 Descriptors (explicit, nothing inherited)

| fd | Direction | Content |
| --- | --- | --- |
| 0 | helper stdin | `/dev/null` (the payload has no stdin in this stage) |
| 1, 2 | helper → host | payload stdout, stderr; bounded readers in Node |
| 3 | host → helper | launch spec, written then closed; read until EOF, size capped |
| 4 | helper → host | status records (section 4.5) |
| 5 | host → helper | control pipe: one byte `K` means "kill the cell now"; EOF means the host died, also kill |

The helper sets `FD_CLOEXEC` on 3, 4, 5 immediately and calls `close_range(6, ~0U, 0)` before `clone3`; the child therefore cannot pass any of them to the payload. The integration test runs `ls /proc/self/fd` as the payload and asserts only 0, 1, 2 (CLAUDE.md 5.1 last bullet). **Hypothesis**: Node passes `stdio` entries beyond 2 as plain inherited fds; confirmed in step 1.

### 4.3 Namespaces and id maps

- One `clone3` call creates all eight namespaces at once, so the child never exists half-isolated. **Hypothesis**: `CLONE_NEWTIME` is accepted by `clone3` on this kernel (supported since Linux 5.6 per clone(2)); if not, the `time` layer is reported unavailable and the run is refused (fail closed), and I stop and report rather than drop it.
- Parent writes `/proc/<pid>/setgroups` = `deny`, then `gid_map` `0 <host gid> 1`, then `uid_map` `0 <host uid> 1`. This is the only mapping an unprivileged process may write (user_namespaces(7)); no `newuidmap`/`/etc/subuid` is used or required.
- Inside, the payload is therefore uid 0 with a full capability set **in its own user namespace only**. That is a deliberate interim state (Stage 4 drops capabilities); section 4.9 lists what it permits.
- The child waits on a sync pipe until the maps exist; if the parent fails to write them the child exits and the run is `isolation_unavailable (userns_idmap)`.

### 4.4 The private root

Built by the child, after the maps exist, using only raw syscalls and fixed buffers (CLAUDE.md 5.2, 5.5):

1. `mount(NULL, "/", NULL, MS_REC|MS_PRIVATE)`: stop propagation to the host.
2. `mount("tmpfs", <cell_dir>/root, "tmpfs", MS_NOSUID|MS_NODEV, "size=<bytes>,mode=0755")` where `<cell_dir>` is the per-cell directory created and owned by the host (section 4.6). Mount options are built from validated integers only (CLAUDE.md 6.2).
3. Create `usr`, `proc`, `dev`, `tmp`, `etc`, `.old` inside it, and the merged-usr symlinks `bin → usr/bin`, `lib → usr/lib`, `lib64 → usr/lib64`, `sbin → usr/sbin`.
4. Bind `/usr` read-only **(superseded by Amendment 1: a composite bind, not a single recursive bind)**: `MS_BIND|MS_REC` then `MS_REMOUNT|MS_BIND|MS_RDONLY|MS_NOSUID|MS_NODEV` **preserving the locked flags read back with `statvfs`/`/proc/self/mountinfo`** (a user namespace cannot clear flags that are locked on inherited mounts, and a remount that omits them fails with `EPERM`). The helper then **verifies** `ST_RDONLY` and `ST_NOSUID` with `statvfs` on the bind and aborts if either is missing; a read-only claim that is not checked is not a layer.
5. Mask Node.js: bind an empty read-only file over `usr/bin/node`, `usr/bin/nodejs`, and an empty directory over `usr/include/node` and `usr/lib/node_modules` when they exist (CLAUDE.md 6.1 item 2). This is a best-effort deny list on top of the host `/usr`, not a minimal rootfs; see section 11 item 2.
6. Fresh `proc` at `<root>/proc` with `MS_NOSUID|MS_NODEV|MS_NOEXEC`, mounted by PID 1 of the new pid namespace. The kernel refuses a new procfs in a user namespace if the host `/proc` has overmounts (`mount_too_revealing`); we mount it before anything is stacked over the host's `/proc`. **Hypothesis**, confirmed in step 1.
7. `/dev`: a `tmpfs` with bind mounts of host `/dev/{null,zero,full,random,urandom,tty}` on empty files (device nodes cannot be created in a user namespace), plus a `tmpfs` `/dev/shm`. No `devpts` in this stage (no terminals).
8. `/tmp`: `tmpfs`, size-capped (`size=` from the spec, default 16 MiB), mode 1777. `/etc`: synthesised `passwd`, `group`, `hosts` written by the helper from constants (`root` only, hostname `aegis`); no host `/etc` content.
9. `pivot_root(<root>, <root>/.old)`, `chdir("/")`, `umount2("/.old", MNT_DETACH)`, `rmdir("/.old")`. After this, no host path is reachable except through the read-only `/usr` and the six device nodes.
10. `sethostname("aegis")`.

Absent on purpose (CLAUDE.md 6.1 item 2): `/mnt`, `/home`, `/root`, `/run`, `/var`, `/sys`, `/boot`, `/media`, Windows interop and Docker sockets.

### 4.5 Status records and fail-closed behaviour

fd 4 carries newline-terminated ASCII records the helper writes with `write(2)` from fixed buffers; Node parses them with a strict hand-written guard (no `JSON.parse` of helper text on this path):

```
layer <name> ok            userns | pidns | mountns | netns | ipcns | utsns | cgroupns | timens | root | proc | dev
layer <name> fail <errno>  setup failed; the helper terminates the cell before exec
started <pid_in_host_ns>   payload exec'd; host pid for diagnostics only
exited <code>              normal exit status of PID 1
signaled <signo>           PID 1 killed by signal
```

A `fail` record means the payload never ran. The control plane maps it to result `error: "isolation_unavailable"`, `layer: <name>`, with the raw errno. There is no code path that runs the payload after a failed layer.

### 4.6 Control plane (TypeScript)

| Piece | File | Notes |
| --- | --- | --- |
| Request schema | `src/gateway/request.ts` | `zod` `.strict()`: `id` (string, `[A-Za-z0-9_.-]{1,64}`), `command` (1 to 64 argv strings, absolute first element, each ≤ 4 KiB, no NUL), `env` (≤ 32 entries, names `[A-Z_][A-Z0-9_]*`, `LD_*` rejected, ≤ 8 KiB total), `limits.wall_ms` (1 to 60 000, default 10 000), `limits.output_kb` (1 to 1024, default 256). Request body byte cap checked before parsing. `__proto__`, `constructor`, `prototype` keys rejected (CLAUDE.md 6.4). |
| Spec encoder | `src/sys/launch-spec.ts` | Pure function: validated values → `Uint8Array` (magic, version, length, tag/length/value entries). Unit and property tests round-trip against a TS reference decoder. |
| Cell directory guard | `src/util/tempdir.ts` | `Symbol.asyncDispose`, created `0700` under `os.tmpdir()`, removed in `finally`. |
| Launch + supervise | `src/launch/run-cell.ts`, `src/supervise/cell-supervisor.ts` | Spawn helper with `stdio: ['ignore','pipe','pipe',<spec>,<status>,<control>]`, bounded readers, wall timer. On timeout or output cap: write `K` to fd 5, then `SIGKILL` the helper after a short grace as a backstop; always await helper exit with its own timeout. |
| Classifier (minimal) | `src/collect/classify.ts` | `exit`, `timeout`, `signal:<NAME>`, `output_limit` (stdout/stderr cap hit; reported now because `runBounded` already detects it), `isolation_unavailable`. The rest is Stage 2. |
| CLI | `src/main.ts` | `aegis run [--file path]`: request from file or stdin (size-capped read), one JSON result on stdout, exit 0 when a result was produced. |

Result shape (stable, extended in Stage 2):

```json
{ "id": "r1", "exit_code": 0, "stdout": "hi\n", "stderr": "",
  "termination": { "cause": "exit" },
  "usage": { "wall_ms": 14 },
  "isolation": { "layers": { "userns": true, "pidns": true, "mountns": true, "netns": true,
                             "ipcns": true, "utsns": true, "cgroupns": true, "timens": true,
                             "root": true, "proc": true, "dev": true } } }
```

`isolation.layers` is built only from `layer <name> ok` records, never from the probe or from configuration, so the receipt cannot claim more than the helper did.

### 4.7 Teardown

The cell has no processes left when PID 1 exits (pid namespace rule). Host side, always in `finally`: close fds, await helper exit, remove the cell directory through its guard. If the helper cannot be awaited within its timeout it receives `SIGKILL`; the child has `PR_SET_PDEATHSIG(SIGKILL)` set before the maps are released, so a dead helper cannot leave a live cell. The orphan reaper and `cgroup.kill` are Stage 2 and are listed as a known limitation.

### 4.8 Native structure

New: `native/src/spec.{c,h}` (parser), `native/src/boot.{c,h}` (boot sequence), `native/src/fuzz_spec.c` (libFuzzer target, built only by the `fuzz` mode). Modified: `sys.{c,h}` (typed wrappers added for `clone3` arguments struct, `pidfd_send_signal`, `close_range`, `pivot_root`, `waitid`; `mount`/`umount2`/`sethostname`/`prctl` are libc functions and are called directly, only `syscall()` stays inside `sys.c`), `main.c` (dispatch `boot`). No `malloc` after `clone3`; the parser fills a static fixed-size structure before the call.

### 4.9 What a payload can still do after this stage (stated, not hidden)

- It is uid 0 with capabilities in its own user namespace: it can create further namespaces, mount `tmpfs`/`proc`/bind mounts inside its own mount namespace, and call `mknod`-adjacent interfaces that need no device access. It cannot reach host files outside `/usr`, host processes, or the network.
- `/usr` is the host's `/usr`: readable (including every binary there), writable only if both the `ro` bind and DAC fail. DAC holds because host `/usr` is owned by host root, which is not mapped, but the `ro` flag itself can be cleared by a process with `CAP_SYS_ADMIN` in its own namespace once locked flags allow it. Stage 4 (capability drop, seccomp denying `mount`) closes that; until then the fixture-only rule applies.
- Memory, CPU and process counts are unlimited except by wall-clock timeout (Stage 2).
- Therefore: **no run of untrusted code outside the test fixture until Stage 4**, and the report states this.

### 4.10 The five contributions

1. Diff-then-commit: untouched here; `files` and workspaces are Stage 3, so Stage 1 cannot weaken it.
2. Fail-closed receipts: introduced in minimal form (4.5, 4.6): every layer is established or the run is refused, and the response lists only layers the helper confirmed.
3. Termination causes: `exit`, `timeout`, `signal:*`, `output_limit`, `isolation_unavailable` classified now; the remainder in Stage 2.
4. Manifests: not started (Stage 4); request limits here are validated and clamped by the schema bounds, not by a ceiling policy.
5. Escape corpus: probes 1, 3, 5, 11 become real tests with the layer expected to stop each one recorded.

## 5. Files

New TypeScript (about 700 lines with tests excluded): `src/gateway/request.ts`, `src/sys/launch-spec.ts`, `src/util/tempdir.ts`, `src/launch/run-cell.ts`, `src/supervise/cell-supervisor.ts`, `src/collect/classify.ts`, `src/sys/status.ts` (status record guard).

New native (about 600 lines of C): `native/src/spec.c`, `spec.h`, `boot.c`, `boot.h`, `fuzz_spec.c`.

New tests: `tests/unit/{request,launch-spec,status,classify,tempdir}.test.ts`, `tests/integration/run-cell.test.ts`, `tests/escape/{harness.ts,probe-01-rm-rf.test.ts,probe-03-mnt-c.test.ts,probe-05-network.test.ts,probe-11-signals.test.ts}`, `tests/fuzz/README.md`.

Modified: `src/main.ts` (`run` mode), `native/src/{main.c,sys.c,sys.h}`, `scripts/build-native.mjs` (sources list, `fuzz` mode), `package.json` and `package-lock.json` (`zod`), `eslint.config.js` only if a rule needs a test override (recorded in the report), `docs/SETUP-WSL2.md` (Stage 1 section), `docs/STAGES.md`, `docs/reports/stage-1.md`, a new ADR if a design decision departs from this prompt.

## 6. Dependencies and privileged actions

- **New runtime dependency: `zod`.** Justification: CLAUDE.md 2 names it as the strict schema validator from Stage 1; hand-written validation of an untrusted request would be larger and easier to get wrong. Exact pin by `npm install --save-exact --ignore-scripts zod`; the resolved version, its transitive package count (expected 0, **hypothesis**) and install-script status (expected none) are recorded in the report, and the lockfile diff is reviewed before commit.
- **Not added:** `@jazzer.js/core` (native addon, needs an install script; deferred, section 11 item 4).
- Packages the owner must install: none. `libclang-rt-21-dev` (already installed) provides the libFuzzer runtime; **hypothesis** that `libclang_rt.fuzzer-x86_64.a` is present, confirmed in step 1. No `libseccomp` yet.
- Privileged actions (`sudo`, `wsl.conf`, systemd, cgroups): **None.** The engine runs unprivileged; nothing here edits system files.
- Network: `npm install zod` only.

## 7. Step-by-step plan

1. **Spike (native, throwaway in `native/spike/`, deleted before commit):** on this kernel, in a single-threaded process: `clone3` with all eight `CLONE_NEW*` flags and `CLONE_PIDFD`; parent-written `setgroups`/`gid_map`/`uid_map`; in the child, private mount propagation, tmpfs, bind `/usr` ro with preserved flags, procfs, device binds, `pivot_root`. Record which step fails with which errno. **If any hypothesis fails, stop and amend this prompt** (CLAUDE.md 0.5).
2. Launch-spec format: native parser with caps and unknown-key rejection, TS encoder, round-trip and property tests, libFuzzer target built and run.
3. `boot`: namespaces and id maps, status records, fail-closed paths; run under `debug-asan`.
4. `boot`: root construction, ro verification, Node masking, proc, dev, `pivot_root`, hostname.
5. `boot`: exec of the payload, descriptor hygiene, `pidfd` kill, control pipe, `PDEATHSIG`.
6. TypeScript: request schema, tempdir guard, supervisor, classifier, `aegis run`.
7. Integration tests (echo, exit codes, timeout, output cap, descriptor list, `/proc` contents, mounts list, hostname, uid/gid maps, root listing).
8. Escape harness and probes 1, 3, 5, 11, each with a control assertion proving the probe was meaningful.
9. `npm run check`, native builds under GCC and Clang for `release` and `debug-asan`, `clang-tidy`, `clang-format`, fuzz run, report, `docs/STAGES.md`.
10. Commit incrementally on `stage/1-core-cell` (created from the tip of `stage/0-scaffold` at approval); the last commit holds the report and `done`.

## 8. Tests and acceptance gate

**Unit and property:** request schema accepts valid requests and rejects unknown fields, oversize bodies, `__proto__` keys, NUL bytes, relative `command[0]`, `LD_*` env; spec encoder/decoder round-trip; status guard rejects malformed records; classifier table; tempdir guard removes on error and on success; fast-check: encoder never exceeds the cap and never throws on arbitrary valid input.

**Integration (`needs_userns`; if the probe says a feature is missing the test fails with a clear message, never passes silently):**

- `echo hi` → stdout `hi\n`, `exit`, code 0, all eleven layers `true`.
- Non-zero exit and signal exit classified correctly; `sleep 30` with `wall_ms: 500` → `timeout`, helper gone, cell directory removed, wall time within a stated tolerance.
- Output flood → `output_limit`, captured bytes ≤ cap.
- Inside the cell: `cat /proc/self/uid_map` is `0 <uid> 1`; `hostname` is `aegis`; `ls /` lists exactly `bin dev etc lib lib64 proc sbin tmp usr`; `/proc/self/mountinfo` has no host paths other than `/usr`; `ls /proc/self/fd` lists only 0, 1, 2; `ls /proc` shows only pids of the cell; `env` is exactly the request env plus the fixed `PATH`; `/usr/bin/node` is empty.
- Failure injection: a spec requesting a nonexistent bind source yields `isolation_unavailable` and the payload marker file is absent.

**Escape probes (harness creates a fake `HOME` and sacrificial tree under a temp directory; CLAUDE.md 6.5):**

| Probe | Payload | Pass condition | Layer expected to stop it |
| --- | --- | --- | --- |
| 1 | `rm -rf /` (and `rm -rf` of the fixture path) | all fixture files byte-identical afterwards; host `/usr` unchanged; control: the fixture path does not exist inside the cell | mount ns + `pivot_root`, ro `/usr` |
| 3 | `ls /mnt/c/Users`, `touch /mnt/c/aegis-probe` | both fail with `ENOENT`; control: the harness asserts `/mnt/c` exists on the host, otherwise the test fails as "inconclusive" | `pivot_root` (no `/mnt`) |
| 5 | TCP connect to `1.1.1.1:443` and to the host's default-gateway address (read from host `/proc/net/route` by the harness) via `bash` `/dev/tcp` or `python3` | both fail with network unreachable; `/proc/net/dev` inside lists only `lo`, down | net ns |
| 11 | `kill -9 -1`, and `kill -9 <pid of a sentinel process the harness started on the host>` | the sentinel is still alive afterwards; the second kill reports no such process; control: the sentinel's pid is not visible in the cell's `/proc` | pid ns |

A probe that succeeds against the full stack is a **finding**: reported prominently and the stage stops (CLAUDE.md 7).

**Sanitizers and fuzzing:** every native test path run with the `debug-asan` helper (ASan + UBSan) and with `release`; launch-spec libFuzzer target runs for at least 5 minutes or 1 000 000 executions with the corpus committed and no crash.

**Definition of done** (CLAUDE.md 0.6): all of the above measured and recorded; `npm run check` green; `clang-tidy`/`clang-format` clean; `docs/reports/stage-1.md` with commands, measured numbers (including run latency median over at least 20 runs, reported as measured, not as a benchmark), deviations, limitations (4.9), and the branch and final commit hash; `docs/STAGES.md` set to `done`; everything committed on `stage/1-core-cell`, clean tree. Nothing pushed or merged by Claude.

## 9. Risks and mitigations

- **Unprivileged mount restrictions in a user namespace** (locked flags, procfs overmount check, `/dev` bind sources): step 1 spike finds them first; the design reads actual flags instead of hard-coding them; if something cannot be made to work, I stop and amend rather than weaken (no silent fallback to a less isolated root).
- **`CLONE_NEWTIME` or another namespace unsupported via `clone3`**: refuse the run and report; I do not drop the layer without an owner decision.
- **Host `/usr` exposure** (section 4.9): accepted interim risk, mitigated by the verified read-only bind, DAC, the fixture-only testing rule, and Stage 4. Section 11 item 2 records the owner's choice over the stricter alternative.
- **Race: id maps written after the child runs** : sync pipe, child blocks until released.
- **Descriptor leaks into the payload**: `CLOEXEC`, `close_range`, and a test that lists `/proc/self/fd` in the cell.
- **Wall-clock kill races a normal exit**: kill goes through the `pidfd`, which cannot be recycled onto another process; both outcomes classified by which status record arrives first, tested with a 1000-iteration loop of near-simultaneous exit and timeout.
- **Test destructiveness**: only probe 1 is destructive; it runs only through the harness against the fixture, and the helper refuses to exec if the `/usr` read-only check fails (4.4 step 4).
- **Supply chain**: one exact-pinned runtime dependency, scripts disabled, lockfile diff reviewed, `npm audit` reported.
- **ESLint/TypeScript strictness with `zod` inference types**: if a rule must be relaxed for generated types it is a scoped override recorded in the report, not a global change.
- **`/tmp` is a tmpfs on this machine**: sufficient for Stage 1; Stage 3 must re-check xattr support for overlay upper directories there.

## 10. Rollback

All work is on branch `stage/1-core-cell`; back out by deleting the branch or `git revert`. Runtime state is only per-run temporary directories under `os.tmpdir()` named `aegis-cell-*` (remove with `rm -r` after confirming no helper process is running). No cgroups, system mounts or system files are created; namespaces and mounts disappear with the cell's last process.

## 11. Decisions recorded from the owner (2026-10-11)

All five questions were answered with the recommended option; the design above already reflects them.

1. **Base branch:** `stage/1-core-cell` starts from the tip of `stage/0-scaffold` (includes `3b8dcc3`). Claude does not merge or push.
2. **Cell root:** host `/usr` bound read-only with Node.js masked (section 4.4). A minimal static-busybox root is not part of this stage.
3. **Interim identity:** payload is uid 0 mapped to the host uid with namespace-local capabilities until Stage 4 (sections 4.3 and 4.9).
4. **Jazzer.js:** deferred to Stage 5; the TypeScript request parser is covered by fast-check properties in this stage.
5. **Limits:** `wall_ms` default 10 000 (max 60 000), `output_kb` default 256 (max 1024), root tmpfs 64 MiB, `/tmp` 16 MiB.

## Amendment 1 (2026-10-11): `/usr` must be bound as a composite tree

Raised under CLAUDE.md 0.5 after the step 1 spike. The approval of the previous text (SHA-256 `fe8456ac2a7f3063d81568852a7ef1cc8db2981e3edbe92eb219c65c616c556e`, over the draft form) is void; this file needs a new approval.

### A1.1 What the spike measured (kernel `6.18.33.2-microsoft-standard-WSL2`, run unprivileged, no host state changed)

Confirmed hypotheses:

- One `clone3` with `CLONE_NEWUSER | NEWPID | NEWNS | NEWNET | NEWIPC | NEWUTS | NEWCGROUP | NEWTIME | CLONE_PIDFD` succeeds (`CLONE_NEWTIME` included; `/proc/self/timens_offsets` is present inside).
- The parent can write `setgroups=deny`, `gid_map` and `uid_map` (`0 1000 1`); the child is pid 1, uid 0.
- `mount / MS_REC|MS_PRIVATE`, tmpfs root, procfs (mounted before `pivot_root`), the six `/dev` bind mounts, `/dev/shm`, `/tmp`, `pivot_root`, `umount2(/.old)`, `sethostname` all succeed. After pivot the root lists exactly `bin dev etc lib lib64 proc sbin tmp usr`, the network namespace has only `lo`, writes to `/usr` give `EROFS`, and the host cell directory is removable afterwards.
- `statvfs` on a bind reports `ST_RDONLY`, `ST_NOSUID`, `ST_NODEV` after the remount, so the verified-read-only rule (4.4 step 4) is implementable.
- The payload has `CapEff 000001ffffffffff` (namespace-local), as section 4.9 already states.

Refuted: **a single recursive bind of host `/usr` is not acceptable.** On this machine WSL mounts three filesystems under `/usr`, and `MS_BIND|MS_REC` copies them into the cell:

| Host path | Filesystem | Why it must not be in a cell |
| --- | --- | --- |
| `/usr/lib/wsl/drivers` | 9p (`drivers`, Windows driver store) | exposes Windows files (CLAUDE.md 6.1 item 2) |
| `/usr/lib/wsl/lib` | overlay (GPU libraries) | WSL host integration, no GPU support (CLAUDE.md 1.3) |
| `/usr/lib/modules/<kernel>` | overlay (kernel modules) | host kernel information |

Measured on the alternatives: a non-recursive `MS_BIND` of `/usr` fails with `EINVAL` (the kernel refuses to bind a mount that has locked children without also copying them), and `umount2` of the three copied submounts fails with `EINVAL` (they are locked). Over-mounting them with an empty tmpfs would hide them, but a payload holding `CAP_SYS_ADMIN` (which it does until Stage 4) could unmount the tmpfs and reveal them, so that is rejected.

Validated alternative (composite bind): walk `/usr`, bind every directory that contains no submount as a whole (`MS_BIND|MS_REC` on a leaf-like directory succeeds), recurse into directories that do contain one, skip the submount paths themselves, recreate symlinks, bind regular files individually. Measured on this machine: 75 bind mounts, all 75 remounted read-only with `nosuid,nodev` and verified, no 9p or overlay mount in the cell, the payload shell ran.

### A1.2 Design change

1. **Plan in TypeScript, execution in C.** A new `src/launch/rootfs-plan.ts` reads `/proc/self/mountinfo` and the host `/usr` tree and produces an ordered list of `{kind: bind-dir | bind-file | symlink, source, target, link}` entries. The launch spec gains repeated `ROOT_ENTRY` records (cap 512 entries and 64 KiB total; the measured plan is 75 entries). The helper has no directory walking code on the boot path: it only executes the list. Entry paths are validated (absolute, under `/usr` for sources, no NUL, no `..`, no mount-option characters).
2. **Verify, never trust the plan.** After the binds, the helper reads `/proc/self/mountinfo` and aborts with `layer root fail` if any mount under the new root other than the planned ones exists, or if any planned mount lacks `ST_RDONLY | ST_NOSUID | ST_NODEV` after the remount. A host `/usr` that changes between planning and boot (new mount, removed file) therefore fails closed instead of producing a different cell.
3. **Node masking (4.4 step 5) is unchanged** and applied after the composite bind (bind an empty file over `usr/bin/node`, an empty directory over `usr/include/node`); `usr/bin/nodejs` and `usr/lib/node_modules` when they exist. It remains a best-effort deny list, not a security boundary, because of 4.9.
4. **Fixed `/usr`-relative content that lives on submount paths is simply absent** (for example `/usr/lib/wsl/drivers`, `/usr/lib/wsl/lib`, `/usr/lib/modules/*`); the root plan is the only source of what appears in the cell.

### A1.3 Effects on the rest of the prompt

- Section 4.2 and 4.5: no change to descriptors; status records unchanged (`layer root ok|fail` covers the whole root build).
- Section 4.6: adds `src/launch/rootfs-plan.ts`. Section 5: adds `src/launch/rootfs-plan.ts`, `tests/unit/rootfs-plan.test.ts`; `native/src/spec.c` gains the `ROOT_ENTRY` record. Size estimates unchanged in order of magnitude.
- Section 7 step 1 is **done** (spike run in the scratchpad outside the repository, so nothing needs deleting); steps 2 to 10 follow with the plan generator added to step 2 and its verification to step 4.
- Section 8 adds: unit tests of the plan generator on canned `mountinfo` and directory fixtures (submounts skipped, symlinks kept, order parent-before-child, caps enforced) and an integration assertion that `/proc/self/mountinfo` inside a cell contains no `9p` or `overlay` filesystem and that `/usr/lib/wsl/drivers` has no entries. Latency of a run is reported with the 75-bind plan (measured, not estimated).
- Section 9 adds a risk: host `/usr` layout differs between machines and distributions; mitigated by planning at run time from the actual mount table, the verify-after-bind rule, and fail closed. A plan with more than 512 entries is refused with a clear error rather than truncated.
- Sections 1 to 3, 4.1 to 4.4 (except step 4's mechanism), 4.7 to 4.10 and 6 to 11 are unchanged. No new dependencies and no privileged actions.
