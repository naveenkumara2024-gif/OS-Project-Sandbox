---
stage: 0
name: scaffold
status: draft
created: 2026-10-11
approved_at:
approved_sha256:
---

# Stage 0: Scaffold (TypeScript + native helper)

## 1. Goal

At the end of this stage the repository has a strict TypeScript project that type-checks, lints, formats and tests cleanly, plus a minimal native helper `aegis-cell` that builds in `release` (static) and `debug-asan` modes. `aegis probe` runs on the owner's WSL2 machine and prints the **raw** kernel facts relevant to later stages as one JSON object (facts only: no isolation level, no pass/fail verdicts). The `Result<T>` type, the disposable fd guard, the bounded child-process helper, the CI skeleton and the `docs/` skeleton exist. No sandbox behaviour exists yet.

## 2. Context

- CLAUDE.md (revised per ADR 0001): §2 toolchain, §2.1 settings, §2.2 syscall access, §3.1 probe-never-assume, §4 architecture and layout, §5 standards, §6.7 supply chain, §7 testing, §8.2 Stage 0 row.
- `docs/BLUEPRINT.md` is **not present** at the time of drafting; this prompt derives from CLAUDE.md only (open question 1).
- The earlier C++ prompt `stage-0-scaffold-cpp.md` is superseded and was never approved.
- No earlier reports or probe results exist; this stage produces the first.

## 3. In scope / out of scope

In scope:

- `package.json` (ESM, `engines`, scripts), exact-pinned dev dependencies, `tsconfig.json` with the §2.1 strict flags, `eslint.config.js` (`strict-type-checked`), `.prettierrc.json`, `vitest.config.ts`, `.gitignore`.
- `src/main.ts`: mode dispatch only. `probe` implemented; `run`, `serve`, `mcp` print "not implemented in stage 0" to stderr and exit 64.
- `src/util/`: `Result<T>` and `Err` (errno code + context), `OwnedFd` disposable guard.
- `src/sys/`: `runBounded()` (spawn with argv + explicit env, timeout, hard output cap, no shell) and a helper client that locates and invokes `aegis-cell`.
- `src/probe/`: procfs and cgroup parsers (pure functions), probe aggregation, JSON output.
- `native/`: `aegis-cell` with exactly one subcommand, `probe`; typed syscall wrappers for `clone3`, `openat2`, `pidfd_open`, `landlock_create_ruleset`; every other subcommand exits 64 with "not implemented".
- `scripts/build-native.mjs`: builds the helper by argument vector (modes `release`, `debug-asan`).
- `.clang-format`, `.clang-tidy` for `native/`.
- `.github/workflows/ci.yml` skeleton (Node check job, native build matrix GCC and Clang). Not executed in this stage.
- `docs/STAGES.md`, `docs/SETUP-WSL2.md`, `docs/adr/0000-template.md`, `docs/reports/.gitkeep`.

Out of scope (and the stage that covers it):

- Namespaces, cells, cgroups, mounts, overlay for real (Stage 1 onward), except the probe's throwaway `unshare(CLONE_NEWUSER)` in a forked child (section 4).
- `zod`, request/manifest schemas, launch-spec protocol (Stage 1). Jazzer.js and fuzz targets (Stage 1; see risks). Isolation level and receipts (Stage 2). `fsop` (Stage 3). seccomp and `libseccomp` (Stage 4). `rsync` (Stage 3).

## 4. Design

**Why a helper exists even in Stage 0.** Node can read `/proc` but cannot call `clone3`, `openat2`, `pidfd_open` or Landlock. The syscall-level facts must come from a native process, so the helper skeleton and its build are part of the scaffold (ADR 0001).

**Fact shape.** Every fact is `{ "value": <json>, "source": "<file or syscall>", "errno": <int|null> }`, so failures are visible rather than hidden, and Stage 2's fail-closed receipt can be built from the same shape.

| Fact | Produced by | Source |
| --- | --- | --- |
| kernel release/version, arch, hostname-free | TS | `os.release()`, `os.arch()`, `/proc/version` |
| Node.js version, platform, uid/gid | TS | `process.versions`, `process.getuid()` |
| WSL marker (informational only, never used to infer support) | TS | `/proc/sys/kernel/osrelease` |
| user-namespace limit | TS | `/proc/sys/user/max_user_namespaces` |
| cgroup v2 mounted, own cgroup path, controllers, subtree_control, writability | TS | `/proc/self/mountinfo`, `/proc/self/cgroup`, `cgroup.controllers`, `cgroup.subtree_control`, `fs.access(W_OK)` |
| `cgroup.kill`, `memory.peak` present (existence only) | TS | file existence under own cgroup |
| overlayfs listed | TS | `/proc/filesystems` |
| working-directory filesystem type | TS | `fs.statfsSync(cwd).type` (number, reported raw) |
| `/mnt/c` and WSL interop entries visible | TS | existence checks (fact only) |
| `clone3` implemented | native | call with size 0: `EINVAL` = present, `ENOSYS` = absent |
| `openat2` with `RESOLVE_BENEATH` | native | call on `.` |
| `pidfd_open` | native | on own PID |
| Landlock ABI version | native | `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)` |
| seccomp mode, `no_new_privs` (read only; nothing is set) | native | `prctl(PR_GET_SECCOMP)`, `prctl(PR_GET_NO_NEW_PRIVS)` |
| unprivileged user namespace creation really works | native | `fork()` a child that calls `unshare(CLONE_NEWUSER)` and `_exit`s; helper is single-threaded |
| helper present / executable / version string | TS | `fs.access(X_OK)`, spawn result |

Not probed yet (needs a real cell, Stage 1/2): unprivileged overlay mount inside a userns, `CLONE_INTO_CGROUP`.

**Helper output.** One JSON line on stdout, written with a tiny fixed-buffer emitter in C (integers and fixed strings only). TS parses with `JSON.parse` and a hand-written shape guard (no `zod` yet). A missing or failing helper becomes a fact (`native_helper.available=false` with errno), not an exit failure; `aegis probe` exits non-zero only if it cannot produce output at all.

**Result and guards.** `Result<T>` is a discriminated union `{ok:true,value}|{ok:false,error}` with `error = { code: string /* errno name or 'EPROTO' etc. */, context: string }`. `OwnedFd` wraps a numeric fd, implements `Symbol.dispose`, closes exactly once, and is the only place `fs.closeSync` is called. TS 5.2+ `using` is downleveled by `tsc`; target and lib settings recorded in the report.

**`runBounded`.** `spawn` with `shell: false`, absolute binary path, explicit `env`, `stdio` explicit, wall-clock timeout via `AbortSignal.timeout`, stdout/stderr read into capped buffers (kill and report `output_limit` on overflow). This is the template the supervisor reuses in Stage 1.

**Five contributions.** None implemented here; nothing weakens them. The fact shape is chosen to feed contribution 2 (receipts) in Stage 2.

**Alternatives considered.** Pure-TS probe without the helper (rejected: cannot observe `clone3`/`openat2`/Landlock). Vendoring a JSON library for the helper (rejected: not needed; helper emits only, never parses).

## 5. Files

New (~1,300 lines expected: ~700 TS including tests, ~400 C, rest config/docs):

| File | Purpose |
| --- | --- |
| `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, `vitest.config.ts`, `.gitignore` | TS project and tooling |
| `.clang-format`, `.clang-tidy` | native style/lint |
| `src/main.ts` | mode dispatch |
| `src/util/result.ts`, `src/util/fd.ts` | `Result`, `OwnedFd` |
| `src/sys/run-bounded.ts`, `src/sys/helper.ts` | bounded child I/O, helper client |
| `src/probe/procfs.ts`, `src/probe/probe.ts` | parsers, aggregation |
| `native/src/main.c`, `sys.c`, `sys.h`, `probe.c` | helper |
| `scripts/build-native.mjs` | native build |
| `tests/unit/*.test.ts` | unit and property tests |
| `.github/workflows/ci.yml` | CI skeleton |
| `docs/STAGES.md`, `docs/SETUP-WSL2.md`, `docs/adr/0000-template.md`, `docs/reports/.gitkeep` | docs skeleton |

Modified: none (`CLAUDE.md`, `docs/STAGES.md` and `docs/adr/0001-*.md` already exist).

## 6. Dependencies and privileged actions

npm dev dependencies (exact-pinned, installed with `npm install --save-exact --ignore-scripts`; resolved versions, transitive count and `npm audit` output go in the report):

| Package | Why |
| --- | --- |
| `typescript` | compiler (`tsc`) |
| `@types/node` | Node API types |
| `vitest` | test runner |
| `eslint`, `typescript-eslint` | lint with type-aware strict rules |
| `prettier` | formatting |
| `fast-check` | property tests for parsers |

No runtime dependencies. I will **not** know install-script behaviour until installed; `--ignore-scripts` is used, and if a listed package fails without its script I stop and ask (§6.7).

Network access: `npm install` of exactly the packages above, nothing else.

Packages the owner installs (Ubuntu on WSL2; I will not run these): `build-essential clang clang-tidy clang-format` and Node.js ≥ 22 LTS (method of your choice: nvm, NodeSource or distro; documented in `docs/SETUP-WSL2.md`). No `libseccomp-dev`, `rsync` or `libclang-rt` yet.

Privileged actions (`sudo`, `wsl.conf`, systemd, cgroup ownership): **None** by Claude.

## 7. Step-by-step plan

1. Repo layout, docs skeleton, `.gitignore`, formatter/lint configs.
2. `npm install` of the listed dev dependencies; `tsconfig`, ESLint, Prettier, Vitest wired; `npm run check` green on an empty `main.ts`.
3. `Result`, `OwnedFd`, with unit tests.
4. `runBounded` with unit tests (timeout, output cap, non-zero exit, missing binary).
5. Procfs parsers (`mountinfo`, `/proc/self/cgroup`, `/proc/filesystems`, controller lists) with unit tests on canned fixtures and fast-check "never throws on arbitrary text" properties.
6. Native helper: `sys.c` wrappers, `probe.c`, `main.c`; `build-native.mjs`; both modes build with `-Werror` under GCC and Clang.
7. Helper client and probe aggregation; `aegis probe` end to end; shape-guard test.
8. `clang-tidy` and `clang-format` on `native/`; CI skeleton.
9. Run everything, write `docs/reports/stage-0.md` with measured results.
10. Commit on branch `stage/0-scaffold` (created from `main` at approval; commits made incrementally per step above, final commit holds the report and the `done` state). Any later fix to this stage is committed on the same branch (CLAUDE.md §0.8, §10).

## 8. Tests and acceptance gate

Unit/property (Vitest, fast-check): `Result` helpers; `OwnedFd` single close and move-out; `runBounded` timeout, cap, exit codes, no shell interpretation of metacharacters in args; every procfs parser on fixtures including malformed input; probe shape guard accepts the real helper line and rejects tampered ones; probe smoke test emits all documented keys and **asserts nothing about feature support**.

Escape probes: **none** (corpus starts at Stage 1).

Gate, all measured and recorded in the report:

1. `npm ci --ignore-scripts` succeeds from the committed lockfile.
2. `npm run check` (`tsc --noEmit`, `eslint --max-warnings 0`, `prettier --check`, `vitest run`) is green.
3. `npm run build:native` succeeds for `release` and `debug-asan` with `-Werror` under both GCC and Clang (versions recorded); `file`/`ldd` output of the `release` helper recorded, static linking attempted and any failure documented.
4. `aegis probe` exits 0 on the owner's WSL2 machine; its output is parsed by a test (not checked by eye) and pasted into the report; the helper's `debug-asan` run under `probe` reports no sanitizer findings.
5. `clang-tidy` and `clang-format --dry-run` clean on `native/`.
6. No file outside the repository touched; no `sudo` run by Claude.
7. All work committed on `stage/0-scaffold` with a clean working tree; the report lists the branch, base commit and final commit hash. Nothing pushed or merged.

## 9. Risks and mitigations

- **Repo on `/mnt/c`**: forbidden for build/run (CLAUDE.md §3), and `node_modules` on a 9p mount is slow and symlink-hostile. Mitigation: open question 2; I run no build until a Linux-filesystem location is confirmed.
- **Windows host vs WSL2 for Claude's commands**: this session's shell is on Windows. Native build and probe verification need WSL2; if I cannot run commands inside the owner's WSL2 distribution, I will say so and leave the stage at `in-progress` with exact commands for the owner, rather than claiming verification.
- **npm supply chain / install scripts**: `--ignore-scripts`, exact pins, audit output in report. Jazzer.js (native addon, likely needs scripts) is deliberately deferred to Stage 1 so its approval gets its own decision.
- **Static linking** of the helper may warn or fail. Mitigation: avoid NSS functions; record deviation instead of silently dropping `-static`.
- **Kernel headers** for `clone3`/`openat2` may be missing: local struct definitions with a man-page reference.
- **WSL2 kernel lacks a feature**: reported as a fact with errno; never a failure.
- **`using` declarations** need TS 5.2+ and a compatible target; mitigated by the pinned compiler, recorded in the report.

## 10. Rollback

All changes are new files on branch `stage/0-scaffold`. Back out by deleting the branch or `git revert`; `node_modules/`, `dist/` and `native/build/` are disposable. No cgroups, mounts or system state are created.

## 11. Open questions for the owner

1. **`docs/BLUEPRINT.md` is missing.** Provide a copy, or confirm Stage 0 may proceed from CLAUDE.md alone.
2. **Repository location.** This checkout is on a Windows drive (`/mnt/c` from WSL). Will you move it to the WSL ext4 filesystem (for example `~/aegis-engine`) before approval, or should I only write files here and you run the commands?
3. **Git.** May I `git init` and create branch `stage/0-scaffold`?
4. **Node.js version and CI.** Which Node.js LTS is installed in your WSL2 distro? Is GitHub Actions the right CI skeleton?
5. **Native helper language.** C11 chosen (smaller surface than C++, no exceptions or runtime). Acceptable?
6. **Probe's userns attempt.** The helper forks a child that calls `unshare(CLONE_NEWUSER)` and exits, to learn whether it really works rather than reading a sysctl. Side-effect-free but beyond pure "raw facts". Keep it?
