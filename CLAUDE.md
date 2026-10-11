# CLAUDE.md — AegisEngine

Read this file fully at the start of every session. It is the standing contract between the owner and Claude for this repository. If anything here conflicts with a casual instruction in chat, ask before deviating; if the owner explicitly overrides a rule, record the override in `docs/adr/`.

> Revised 2026-10-11 per `docs/adr/0001-typescript-control-plane-native-helper.md`: the project is TypeScript on Node.js with a small native helper, replacing the earlier C++20 plan. Sections 0, 1.2, 1.3, 6.1 to 6.6 and 8.1 keep their original intent.

---

## 0. The one rule that governs everything: the Stage Gate

**Claude never writes implementation code for a stage until the owner has approved a written implementation prompt for that stage.**

This is not a preference. It is the workflow. The owner controls pace and scope; Claude proposes and waits.

### 0.1 State file

`docs/STAGES.md` is the single source of truth for stage state. Claude reads it at the start of every session.

| Status | Meaning | Who sets it |
| --- | --- | --- |
| `planned` | Defined in section 8, not started | initial |
| `implement` | Owner wants this stage built; **no prompt approved yet** | owner |
| `prompt-drafted` | Claude wrote the stage prompt and is waiting for approval | Claude |
| `approved` | Owner approved the prompt; work may begin | Claude, only after explicit approval |
| `in-progress` | Implementation underway within the approved scope | Claude |
| `verifying` | Code complete; running tests, probes, sanitizers | Claude |
| `done` | Gate criteria met, report written, owner informed | Claude |
| `blocked` | Cannot proceed; reason recorded in the stage file | Claude |

### 0.2 Trigger

A stage is "set to implement" when any of these happens:

- the owner edits its row in `docs/STAGES.md` to `implement`;
- the owner says things like "implement stage 3", "start stage 3", "set stage 3 to implement".

At session start, if any row says `implement` (and no approved prompt exists for it), Claude must begin the gate procedure below before doing anything else for that stage.

### 0.3 Procedure (follow in order, no skipping)

1. **Read** this file, `docs/BLUEPRINT.md`, `docs/STAGES.md`, all reports in `docs/reports/`, and the current state of the repository relevant to the stage.
2. **Draft the stage prompt** at `docs/prompts/stage-<N>-<slug>.md` using the template in section 9. Set its front matter `status: draft`.
3. **Update** `docs/STAGES.md`: stage status becomes `prompt-drafted`.
4. **Present** the prompt to the owner in chat: a short summary (goal, scope, files, risks, privileged actions, acceptance gate) plus the file path. Ask for approval explicitly.
5. **STOP.** Do not create or edit any file outside `docs/prompts/` and `docs/STAGES.md`. Do not install packages. Do not run builds "to check". Wait.
6. **If the owner requests changes**, revise the prompt, keep `status: draft`, present the changes, and wait again.
7. **On approval**, compute `sha256sum` of the prompt file, record `status: approved`, `approved_at` (ISO date) and `approved_sha256` in its front matter, set the stage to `approved`, then `in-progress`, and begin implementation.

### 0.4 What counts as approval

- **Approval:** the owner clearly says "approved", "approve stage N", or "go ahead with the stage N prompt" in response to a specific prompt.
- **Not approval:** silence, "ok", "proceed", "looks good but change X", a question, a thumbs-up, or approval of a different stage. If it is ambiguous, ask once: "Do you approve the Stage N prompt as written?"
- Approval covers exactly the prompt text that was hashed. **If the prompt file changes after approval, the approval is void** and the gate restarts from step 4.

### 0.5 During implementation

- Stay inside the approved scope. If the work needs something the prompt did not cover (a new dependency, a new syscall family, a design change, a privileged setup step, touching another stage's code), **stop**, write an amendment section at the end of the prompt file explaining why, set status back to `prompt-drafted`, and request approval again.
- Small refactors needed to complete in-scope work are fine; record them in the stage report.
- Never start the next stage. When a stage is `done`, report and wait for the owner to set the next one to `implement`.

### 0.6 Definition of done for a stage

All of the following, otherwise the stage stays `verifying`:

1. Every acceptance criterion in the prompt is met, including the listed escape probes.
2. TypeScript: `npm run check` (type-check, ESLint with `--max-warnings 0`, Prettier `--check`, Vitest) passes. Native helper: unit and integration tests pass in the `debug-asan` build (ASan + UBSan) and in `release`.
3. Native code: `clang-tidy` and `clang-format --dry-run` are clean.
4. Docs updated (`docs/` and, if the design changed, an ADR).
5. A stage report exists at `docs/reports/stage-<N>.md`: what changed, commands run, **actual measured results**, deviations from the prompt, known limitations, open questions.
6. `docs/STAGES.md` updated to `done`.

### 0.7 Optional hard enforcement

This file is advisory. If the owner wants deterministic enforcement, add a Claude Code `PreToolUse` hook that exits with code 2 for `Write` or `Edit` calls outside `docs/` unless the active stage in `docs/STAGES.md` is `approved` or `in-progress`. Claude should offer to write it but not install it without approval.

---

## 1. Project overview

**AegisEngine** is a rootless, air-gapped sandbox for running untrusted AI-generated code on WSL2 Ubuntu, built directly on Linux kernel primitives. It creates a throwaway "cell" per request (namespaces, a minimal private root filesystem, a copy-on-write workspace, cgroup v2 limits, privilege dropping and a syscall filter), runs the code, and returns a structured JSON receipt: stdout, stderr, exit code, why the run ended, resource usage, which isolation layers were active, and a diff of every file changed.

The authoritative design is the **AegisEngine R and D Blueprint** (a Claude Docs artifact owned by the user). A copy lives at `docs/BLUEPRINT.md`. Treat it as the source of truth. Deviations are recorded as ADRs in `docs/adr/`, never silently.

### 1.1 Thesis

AegisEngine is a fail-closed, agent-aware sandbox: it tells the AI exactly what isolation it got, exactly what changed, and exactly why a run ended.

### 1.2 The five distinguishing contributions

Every design decision must preserve these. If a change would weaken one, stop and ask.

1. **Diff-then-commit workspaces.** The overlay upper directory is the exact change set. Nothing reaches the real project until a separate, approved `commit`.
2. **Fail-closed isolation receipts.** A startup probe tests each layer for real. Every response states which layers were active. A run requiring a missing layer is refused, never silently weakened.
3. **Termination-cause classification.** Every run ends with a structured cause (`exit`, `timeout`, `oom`, `pids_limit`, `output_limit`, `disk_limit`, `signal:<name>`) plus usage numbers.
4. **Cell manifests as policy-as-data.** Each run declares limits, mounts, network allowlist, required layers in JSON; a human-owned ceiling policy clamps it; the resolved manifest hash is echoed in the receipt.
5. **Escape-test corpus with layer ablation.** A reproducible attack suite, re-run with each defence layer disabled in turn, proves what each layer contributes.

### 1.3 Honest non-goals

Shared host kernel: AegisEngine does not defend against kernel vulnerabilities or hardware side channels. Not for native Windows or WSL1. No GPU support. TypeScript's memory safety applies to the control plane only; the native helper is C and is held to the rules in section 5.5. Do not claim otherwise in docs, comments or reports.

---

## 2. Language, toolchain and dependencies

Two codebases, one rule: **everything that can be TypeScript is TypeScript.** Native code exists only for kernel interfaces Node.js cannot reach (ADR 0001).

| Item | Decision |
| --- | --- |
| Control plane | TypeScript (strict, ESM) on Node.js LTS (minimum 22; the exact version is recorded by the Stage 0 probe and the report) |
| Native helper | `aegis-cell`, C11, built static for `release`. Minimal by rule: new native code needs a justification in the stage prompt |
| Package manager | npm. `package-lock.json` committed. Dependencies pinned to exact versions. Install with `npm ci --ignore-scripts` |
| Build | `tsc` for TypeScript (output `dist/`); `scripts/build-native.mjs` invokes the C compiler by argument vector for the helper (modes: `release`, `debug-asan`, `fuzz`) |
| Runtime dependencies | `zod` (strict schema validation, from Stage 1). Everything else uses Node built-ins (`node:http` over a Unix socket, `node:child_process`, `node:fs`, `node:crypto`) |
| Dev dependencies | `typescript`, `@types/node`, `vitest`, `eslint`, `typescript-eslint`, `prettier`, `fast-check`, `@jazzer.js/core` (fuzzing, from Stage 1) |
| Native libraries | `libseccomp` (Stage 4, linked statically) |
| External tools | `rsync` for workspace ingest, spawned **without a shell** with an argument vector |
| Forbidden | Web frameworks (express, fastify, and the like), CLI frameworks, lodash-style utility packages, any dependency not listed here without owner approval. Each new dependency needs a one-paragraph justification in the stage prompt, an exact pin, and its transitive package count reported |

### 2.1 Required compiler and linter settings

- TypeScript: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `verbatimModuleSyntax`. ESLint uses `typescript-eslint` `strict-type-checked`; `no-explicit-any`, `no-floating-promises`, `no-non-null-assertion` and the `no-unsafe-*` rules are errors. CI runs with `--max-warnings 0`.
- Native: `-std=c11 -Wall -Wextra -Wpedantic -Wconversion -Wshadow -Werror`; hardening `-fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIE -pie -Wl,-z,relro,-z,now`.
- Native `debug-asan` build: `-fsanitize=address,undefined -fno-omit-frame-pointer`, dynamically linked (ASan does not support static glibc).
- Native `release` build is **statically linked** where feasible. Reason: after `pivot_root` the cell root contains only what we put there, so the in-cell helper must not depend on host shared libraries. **Node.js never runs inside a cell.**

### 2.2 System call access

Node.js has no syscall interface. Only `native/` calls `syscall(2)`, through thin typed wrappers in `native/src/sys.c`; no other native file calls `syscall()` directly. The TypeScript side must not use FFI, `process.binding`, native addons or `node-gyp`. If TypeScript needs a kernel feature, it asks the helper.

---

## 3. Target environment

- **OS:** WSL2 Ubuntu (a real Linux kernel built by Microsoft; WSL1 is unsupported). Editing from Windows is fine; **running and building happens inside WSL2.**
- **Work location:** Linux ext4 filesystem (for example `~/aegis-engine`). **Never build, run, install `node_modules` or stage anything under `/mnt/c`.**
- **Privilege:** the engine runs as an ordinary user. It must never require `sudo` at runtime. One-time system setup (systemd, cgroup delegation, Node.js, compilers) is documented in `docs/SETUP-WSL2.md` and performed by the owner.

### 3.1 Probe, never assume

The WSL2 kernel's feature set varies. Do not infer support from a version number. Anything below is a **hypothesis to be confirmed by the startup probe on the owner's machine**, and the receipt must report the probe's answer:

- unprivileged user namespaces and `clone3` with `CLONE_NEW*` flags
- unprivileged overlayfs mounts inside a user namespace (expected Linux 5.11+) and user xattr support on the upper filesystem
- cgroup v2 unified hierarchy with a delegated, writable subtree; which controllers are delegated (typically only `memory` and `pids` by default; `cpu` needs a systemd drop-in)
- `CLONE_INTO_CGROUP`, `cgroup.kill` (expected 5.14+), `memory.peak` (newer kernels)
- seccomp-bpf, `no_new_privs`, Landlock (and its ABI version)
- `openat2` with `RESOLVE_BENEATH`
- whether Windows interop is reachable from inside a cell (it must not be)
- the Node.js version and whether `aegis-cell` is present and executable

---

## 4. Architecture

One command, `aegis` (a Node.js entry point), with these modes, plus the native helper `aegis-cell` that only the control plane invokes:

| Mode | Purpose |
| --- | --- |
| `aegis run` | One-shot: read a request from a file or stdin, execute, print the receipt (used in Stages 1 to 4) |
| `aegis serve` | Local gateway: HTTP over a Unix socket (mode 0600) |
| `aegis mcp` | MCP server over stdio (JSON-RPC) for AI harnesses such as Claude Code |
| `aegis probe` | Run the capability probe and print the isolation report |
| `aegis-cell probe` | **Native, internal.** Raw syscall-level facts, one JSON line on stdout |
| `aegis-cell boot` | **Native, internal.** New namespaces, root build, `pivot_root`, capability drop, seccomp, Landlock, then `exec` of the init |
| `aegis-cell init` | **Native, internal.** PID 1 inside a cell: reaps zombies, forwards signals, supervises the payload |
| `aegis-cell fsop` | **Native, internal, reserved for Stage 3.** `openat2`-confined file operations and xattr reads for ingest, diff and commit |

Control plane (TypeScript, host, unprivileged) never executes payload code. Data plane (the cell, started by the native helper) does nothing except run it. Only data crosses between them: a length-prefixed launch spec in, bounded byte streams and status out, an overlay diff. The launch spec is a flat key/value binary format, **not JSON**, so the helper contains no JSON parser; validation, clamping and hashing of the manifest happen in TypeScript.

### 4.1 Source layout

```text
aegis-engine/
  package.json  package-lock.json  tsconfig.json  eslint.config.js
  .prettierrc.json  vitest.config.ts  .clang-format  .clang-tidy
  src/
    main.ts               mode dispatch only
    sys/                  helper client: spawn aegis-cell, fd passing, launch-spec encoder, bounded child I/O
    util/                 Result type, Disposable fd/cgroup/dir guards, bounded buffers, logger
    probe/                procfs/cgroup parsers, probe aggregation, isolation level computation
    policy/               manifest schema (zod), ceiling policy, clamping, hashing
    stage/                path handling, wslpath, rsync ingest, overlay preparation (confined ops via aegis-cell fsop)
    launch/               cell creation: cgroup creation, launch spec, helper spawn, id maps request
    supervise/            timers, bounded output readers, kill procedure (host side)
    collect/              termination classifier, usage, overlay diff, commit
    gateway/              Unix-socket HTTP server, MCP stdio server, schema validation
    broker/               allowlist egress proxy and audit log
  native/
    src/                  main.c, sys.c, probe.c, boot.c, init.c, (fsop.c in Stage 3)
  tests/
    unit/  integration/  escape/  fuzz/  bench/
  docs/
    BLUEPRINT.md  STAGES.md  SETUP-WSL2.md
    prompts/  reports/  adr/
  scripts/                build-native.mjs and setup helpers (dry-run by default)
  policy.default.json
```

---

## 5. Coding standards

### 5.1 TypeScript rules

- Resource ownership through disposable guards only: file descriptors, mounts (when the host owns any), cgroups, temporary directories and child processes each have a guard type implementing `Symbol.dispose` or `Symbol.asyncDispose`, used with `using` / `await using`. Guarantee cleanup in `finally`. No bare `fs.openSync` without a guard.
- No `any`. No non-null assertions (`!`). No `as` casts on external data: untrusted input goes through a `zod` schema (or a hand-written type guard in Stage 0), then is typed.
- No `eval`, `new Function`, dynamic `import()` of computed paths, or `vm` for payloads.
- Expected failures are values: functions that can fail return `Result<T>` carrying an `errno` code and a context string. Exceptions are for programmer errors and truly exceptional conditions. **Never swallow an error; never `catch {}` silently.** `unhandledRejection` and `uncaughtException` are fatal and logged.
- No floating promises. Every wait on a child or socket has a timeout (`AbortSignal.timeout` or equivalent). Never accumulate unbounded output: all stream reads go through a bounded buffer with a hard cap.
- No `worker_threads` or `cluster`. Prefer `node:` prefixed imports. Prefer `Uint8Array`/`Buffer` views over string concatenation for binary data.
- No `using namespace`-style barrel re-exports that hide module boundaries; one primary exported type per file for non-trivial types.
- Every descriptor handed to a child is passed explicitly in the `stdio` array; nothing else is inherited. Node opens its own descriptors with close-on-exec; Claude does not rely on that for fds the helper must not see, and verifies in the integration tests.

### 5.2 The launch path

The Node.js process is multithreaded (libuv), and `unshare(CLONE_NEWUSER)` fails in a multithreaded process.

- The control plane **never** creates namespaces itself. It spawns `aegis-cell boot`, a fresh single-threaded process, with an argument vector, an explicit environment and explicit descriptors.
- Prepare the launch spec, cgroup directory descriptor and every buffer **before** spawning.
- Inside the helper, between `clone3` returning in the child and the final `exec`, only raw syscalls and fixed buffers: no allocation, no locks, no logging.
- Supervision uses one event loop (readers, timers, `pidfd` via the helper). No extra threads.

### 5.3 Error handling and logging

- Fail closed: if a required layer cannot be established, abort the cell before executing the payload and return `isolation_unavailable` with the failing layer named.
- Structured JSON logging (one object per line) to stderr or a log file. Include request id and manifest hash.
- **Never log payload contents, environment variables, file contents or secrets** at default log levels. Redact by construction: the logger accepts only typed event objects with allowlisted fields, never arbitrary values.

### 5.4 Style

`prettier` (project `.prettierrc.json`, 100 columns) and ESLint for TypeScript; `clang-format` (LLVM base, 100 columns) and `clang-tidy` (`bugprone-*`, `cert-*`, `clang-analyzer-*`) for `native/`. Comments explain **why** (kernel behaviour, security rationale), not what. Reference the blueprint section or kernel man page when relevant.

### 5.5 Native helper rules (C11)

- Check every return value; retry on `EINTR` where appropriate. Every syscall wrapper returns the raw `errno` to the caller.
- `O_CLOEXEC` / `SOCK_CLOEXEC` on every descriptor. Close everything not explicitly passed before `exec`.
- No `malloc`/`free` after `clone3` in the child. No stdio, no `printf` family on the boot path except into fixed buffers written with `write(2)`.
- No shell, no `system()`, no `popen()`. Fixed-size buffers with explicit bounds; no unbounded `strcpy`/`sprintf`.
- The launch-spec parser is the helper's only untrusted-input parser; it has a hard size cap, a version field, rejects unknown keys, and gets a libFuzzer target.

---

## 6. Security rules (red lines)

Violating any of these is a bug regardless of whether tests pass.

### 6.1 Isolation

1. The payload is **never** executed in the engine's own process or address space.
2. The cell root is a fresh tmpfs with explicit read-only bind mounts. It must contain **no** `/mnt`, `/home`, `/root`, `/run`, `/var`, `/sys` (unless a stage prompt justifies a minimal read-only `/sys` entry), no Node.js, and no WSL interop or Docker sockets.
3. Network namespace is created for every cell. Default mode is `none`. Loopback is brought up only if the manifest allows it. Egress, if allowed, goes only through the host broker over a Unix socket.
4. Capabilities are dropped (bounding, inheritable, ambient) and `no_new_privs` is set before the payload runs. The seccomp filter is loaded last.
5. The payload starts with an **explicit allowlisted environment**, never an inherited one.
6. Limits are enforced by cgroup v2 (`memory.max`, `memory.swap.max=0`, `memory.oom.group=1`, `pids.max`, `cpu.max` when delegated) plus rlimits. `RLIMIT_NPROC` is never relied upon.
7. Teardown is guaranteed: `cgroup.kill` (or fallback) then wait for `populated 0`, then remove cgroup and cell directory. A startup reaper removes orphaned cells.

### 6.2 No shell, ever

- Never use `child_process.exec`, `execSync`, `spawn`/`execFile` with `shell: true`, `sh -c`, or build commands by string concatenation. Use `spawn`/`execFile` with an absolute binary path and an argument array, and always an explicit `env`. In C, `execve` with an argument vector.
- Paths and manifest values are **data**, never interpolated into command strings or mount option strings without strict validation (reject commas, NUL, newlines in mount options).

### 6.3 Paths and files

- Resolve and confine all external paths with `openat2` + `RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS` (and `RESOLVE_NO_SYMLINKS` where applicable) against a directory fd of an allowed root. **Node.js cannot call `openat2`, so confined access is performed by `aegis-cell fsop`.** Do not rely on string prefix checks, and never use `path.resolve` plus `startsWith` as a security check. If a `startsWith`-style check is ever written, it must compare with a trailing separator, and an ADR must justify it.
- Windows paths are converted only at the ingest/commit border with `wslpath -u` invoked via argument vector.
- Commit (writing results to the real project) opens targets with `O_NOFOLLOW`, refuses symlinks, device files, FIFOs, sockets, set-uid/set-gid bits, files over the size cap, and any path escaping the workspace root.

### 6.4 Policy and trust

- Everything arriving over the gateway or MCP, **including the manifest, is untrusted.** Enforce a byte-size limit before parsing, validate against a strict schema, clamp to the ceiling policy. The model may ask for less, never more.
- The ceiling policy file lives outside every workspace, is owned by the owner, is read-only to the agent, and is never mounted into a cell.
- Unknown JSON fields are rejected, not ignored (`zod` `.strict()`).
- Parsed untrusted JSON is treated as hostile data: reject `__proto__`, `constructor` and `prototype` keys, never merge it into existing objects, and prefer `Map` or null-prototype objects for caller-supplied keys.

### 6.5 Safe testing (important for Claude)

The escape corpus contains genuinely destructive probes (`rm -rf /`, writing to `/mnt/c`, filling disks, fork bombs). When layers are disabled for ablation, those probes can really succeed.

- Ablation and destructive probes run **only** against a disposable fixture: a dedicated fake `HOME` and sacrificial directory tree created under a temp directory by the test harness. Never against the owner's real home, project or Windows drives.
- Layer-disabling flags exist **only** in native builds configured with `AEGIS_ENABLE_ABLATION=1`, require `AEGIS_TEST_UNSAFE=1` and a fixture path argument, and are compiled out of `release`.
- Claude must never run a destructive probe by hand outside the harness.
- Fork-bomb and memory probes run only with the cgroup layer active, or inside a throwaway WSL distribution the owner has confirmed is disposable.

### 6.6 Never do without explicit owner approval

- `sudo` anything; editing `/etc/wsl.conf`, `/etc/systemd`, `/etc/apparmor.d`, sysctl; changing cgroup ownership.
- Installing system packages (list required packages in the stage prompt and in `docs/SETUP-WSL2.md`; the owner installs them, or approves a specific command).
- Network access beyond fetching pinned dependencies explicitly listed in the approved prompt (this includes `npm install`).
- Touching anything outside the repository directory.
- `git push`, force operations, deleting branches, rewriting history.

### 6.7 Supply chain

npm dependencies are an attack surface for a security tool.

- Exact version pins only (`--save-exact`), lockfile committed, installs with `--ignore-scripts`. A dependency that needs an install script (for example a native addon) requires an explicit owner decision in the stage prompt.
- Resolved versions and the transitive package count are recorded in each stage report. `npm audit` output is reported, not silenced.
- No dependency may be imported from inside a cell; the cell contains only the static helper and the payload.

---

## 7. Testing and verification

| Layer | Tool | Notes |
| --- | --- | --- |
| Unit | Vitest | Pure logic: procfs parsers, path handling, manifest clamping, classifier, schemas, bounded buffers |
| Property | fast-check | Parsers and clamping: round-trips, "never exceeds ceiling", "never throws on arbitrary input" |
| Integration | Vitest + real cells | Tag `needs_userns`. If the probe says a feature is missing, the test **fails with a clear message or is explicitly marked skipped in the report; it never passes silently** |
| Escape corpus | `tests/escape/` | Twenty core probes (section 8.1), grown toward thirty; each tagged with the layer expected to stop it |
| Ablation | `tests/escape/ablation` | Matrix of probe by disabled layer; output committed as a report |
| Fuzzing | Jazzer.js (TypeScript), libFuzzer (native) | Targets: JSON request parser, manifest validator, HTTP request parser, MCP JSON-RPC parser, launch-spec parser (native), `fsop` path handling (native) |
| Benchmarks | `tests/bench/` | Latency (median, p95, 200 runs after 10 warm-up), throughput at concurrency 1/4/16, compared with bare process, `bwrap`, `docker run --rm` |

Rules:

- **Report measured numbers only.** Never quote another project's benchmark as AegisEngine's, never estimate and present it as measured, never claim "tests pass" without having run them in this session.
- A probe that succeeds against the full stack is a **finding**, not something to hide. Report it prominently and stop the stage.
- Run the native `debug-asan` build and the full TypeScript check before declaring any stage `verifying`.

---

## 8. Stages

Status lives in `docs/STAGES.md`. Each stage has acceptance gates tied to probe numbers.

### 8.1 Probe corpus (numbers used by the gates)

1 `rm -rf /` then check fixture files · 2 read `~/.ssh/id_rsa` and `$AWS_*` · 3 list/write `/mnt/c/Users` · 4 run `cmd.exe /c whoami` · 5 connect to `1.1.1.1:443` and the Windows gateway · 6 connect to a host Unix socket (e.g. `/var/run/docker.sock`) · 7 fork bomb · 8 allocate 4 GB · 9 `while True: pass` for 60 s · 10 endless output · 11 `kill -9 -1` and signals to host PIDs · 12 `mount` calls, `mknod /dev/sda` · 13 nested `unshare` and `setns` · 14 `bpf`, `perf_event_open`, `keyctl` · 15 output file that is a symlink to `~/.ssh` · 16 request path `../../etc` or symlinked workspace · 17 fill disk with `dd` · 18 ignore `SIGTERM` as PID 1, leave zombies · 19 plant `.git/hooks/post-checkout` · 20 request 8 GB and an unlisted domain.

### 8.2 Stage list

| # | Stage | Scope | Gate |
| --- | --- | --- | --- |
| 0 | Scaffold | Repo, TypeScript project (tsconfig, ESLint, Prettier, Vitest), native helper skeleton and build script, CI skeleton, `Result` and disposable utilities, `docs/` skeleton, `aegis probe` printing raw kernel facts | `npm run check` green; helper builds in `release` and `debug-asan`; `aegis probe` runs |
| 1 | Core cell | Launch-spec protocol; `aegis-cell boot` with user/pid/mount/net/ipc/uts/cgroup/time namespaces via `clone3`, id maps, tmpfs root + `pivot_root`, minimal `/dev` and fresh `/proc`, JSON in/out via `aegis run` (zod request schema), wall-clock timeout, kill via `pidfd` | Probes 1, 3, 5, 11 stopped |
| 2 | Limits and receipts | cgroup v2 placement (`CLONE_INTO_CGROUP`), `aegis-cell init` as PID 1, full startup probe, isolation level and receipt, termination classifier, output and disk caps | Probes 7 to 10, 17, 18 stopped; receipt present in every response |
| 3 | Workspace | Overlay mount (with copy-and-diff fallback), diff extraction, `commit`/`discard`, `aegis-cell fsop` with `openat2` path guard, `rsync` ingest with excludes | Probes 15, 16, 19 stopped; diff exact on add, modify, delete |
| 4 | Hardening | Capability drop, `no_new_privs`, seccomp via libseccomp, Landlock (probed), environment scrub, manifest schema and ceiling policy | Probes 2, 4, 6, 12 to 14, 20 stopped |
| 5 | Integration | Unix-socket gateway, NDJSON event streaming, `aegis mcp`, egress broker with audit log, example `.mcp.json` and hook | End-to-end session with an AI harness; commit requires approval |
| 6 | Evaluation | Full ablation matrix, fuzz campaigns, benchmark suite, final write-up, optional Node SEA packaging via ADR | Matrix and benchmark committed with raw data; every claim in the blueprint supported or corrected |

Stage 0 is the first to be set to `implement`. Stages must be done in order unless the owner decides otherwise and records it in `docs/STAGES.md`.

---

## 9. Stage prompt template

Every stage prompt is saved as `docs/prompts/stage-<N>-<slug>.md` with this structure. Keep it concrete enough that the owner can approve it without reading code.

```markdown
---
stage: <N>
name: <slug>
status: draft            # draft | approved | superseded
created: <YYYY-MM-DD>
approved_at:
approved_sha256:
---

# Stage <N>: <title>

## 1. Goal
One paragraph: what exists at the end that does not exist now.

## 2. Context
Blueprint sections relied on. Results of earlier stages. Relevant facts from the startup probe.

## 3. In scope / out of scope
Explicit lists. Out of scope names the stage that will cover it.

## 4. Design
Key decisions and why. Alternatives considered. Kernel features and syscalls used, each with its probe and fallback behaviour. Which parts are TypeScript and which are native, and why. How each of the five contributions is preserved.

## 5. Files
New files and modified files, with a one-line purpose each. Expected size of change.

## 6. Dependencies and privileged actions
New npm packages or native libraries (each justified, exact-pinned, install-script status stated). Packages the owner must install. Any `sudo`, `wsl.conf`, systemd or cgroup setup, with exact commands. If none, write "None".

## 7. Step-by-step plan
Ordered, small, individually testable steps.

## 8. Tests and acceptance gate
Unit, property, integration, escape probes (by number), sanitizer runs, fuzz targets. What "done" looks like, measurably.

## 9. Risks and mitigations
Kernel feature missing on WSL2, race conditions, supply chain, security regressions, and what happens if so.

## 10. Rollback
How to back out (branch, revert, cleanup of cgroups and cell directories).

## 11. Open questions for the owner
Anything that needs a decision before work starts.
```

---

## 10. Git and repository workflow

- One branch per stage: `stage/<N>-<slug>`. Commit small, logical units. Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`), imperative mood, body explaining why when non-obvious.
- Never commit a failing build. Never commit secrets, local paths or machine-specific config. `node_modules/`, `dist/` and native build output are ignored; `package-lock.json` is committed.
- Do not push, merge, rebase published history or delete branches without being asked. When a stage is `done`, summarise and let the owner decide about merging.
- Decisions that change the blueprint go in `docs/adr/NNNN-title.md` (context, decision, consequences). Update `docs/BLUEPRINT.md` only when the owner asks, and list proposed edits in the stage report.

---

## 11. How Claude should work and communicate

- **Be concise and factual.** Lead with the outcome. Report what changed, which commands were run, and the actual results.
- **Be honest about failure.** If a test fails, a probe succeeds, or a kernel feature is missing, say so plainly with evidence. Do not paper over it, weaken a test to make it pass, or claim success without running verification.
- **Explain security reasoning briefly** in code comments and stage reports, since this project is also being defended in an operating-systems course.
- **Ask early** when a decision is the owner's: scope changes, new dependencies, privileged setup, trade-offs between isolation strength and convenience, and anything that would add native code.
- **Never fabricate** kernel behaviour, flags, package versions or version numbers. If unsure, check the man page or probe the system, and mark anything unverified as a hypothesis.
- Keep a running task list for each stage's steps. Mark items complete only when verified.
- When a session starts, give a two-line status: current stage and state, and what is waiting on the owner.

---

## 12. Quick reference

| Situation | Action |
| --- | --- |
| Owner says "implement stage N" | Run the Stage Gate procedure (0.3): draft prompt, update `STAGES.md`, present, **stop** |
| Prompt drafted, no explicit approval | Do nothing outside `docs/prompts/` and `docs/STAGES.md` |
| Owner approves | Hash the prompt, record approval, begin work |
| Work needs something outside the approved prompt | Stop, add an amendment, re-request approval |
| Stage complete | Verify, write report, set `done`, wait |
| Destructive probe needed | Only via the harness against the disposable fixture |
| Needs `sudo` or system change | Ask; never run it |
| Needs a kernel interface Node cannot reach | Put it in `aegis-cell`, justify in the stage prompt |
| Kernel feature unavailable | Fail closed, report in the receipt, tell the owner |
