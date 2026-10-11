---
stage: 0
name: scaffold
status: superseded
created: 2026-10-11
approved_at:
approved_sha256:
---

# Stage 0: Scaffold (C++ variant, SUPERSEDED)

> Superseded on 2026-10-11 by the TypeScript variant in `stage-0-scaffold.md` (see `docs/adr/0001-typescript-control-plane-native-helper.md`). Never approved. Kept for history only.

## 1. Goal

At the end of this stage the repository builds a single `aegis` binary in all four CMake presets (`debug-asan`, `debug-tsan`, `release`, `fuzz`) with the required warnings, hardening and sanitizer flags. `aegis probe` runs on the owner's WSL2 machine and prints the **raw** kernel facts relevant to later stages as one JSON object (facts only: no isolation level, no pass/fail verdicts). The `Result<T>` type, the RAII fd guard, the syscall-wrapper layer, the unit-test harness, the lint/format configuration, a CI skeleton and the `docs/` skeleton exist. No sandbox behaviour exists yet.

## 2. Context

- CLAUDE.md §2 (toolchain), §2.1 (flags), §2.2 (syscall wrappers), §3.1 (probe, never assume), §4 (architecture and layout), §5 (coding standards), §7 (testing), §8.2 (Stage 0 row).
- `docs/BLUEPRINT.md` is **not present in the repository** at the time of drafting. This prompt is derived from CLAUDE.md only (see open question 1).
- No earlier stage reports exist. No startup-probe results exist yet; Stage 0 produces the first ones.

## 3. In scope / out of scope

In scope:

- CMake project, `CMakePresets.json` with the four presets, compiler/linker flags from §2.1.
- `.clang-format` (LLVM base, 100 columns), `.clang-tidy` (`bugprone-*`, `cert-*`, relevant `cppcoreguidelines-*`, `performance-*`, `readability-*`), `.gitignore`.
- `src/util/`: `Result<T>` (errno + context), `UniqueFd`, minimal JSON writer (emit only).
- `src/sys/`: typed wrappers over `syscall(2)` for `clone3`, `pivot_root`, `openat2`, `pidfd_open`, `pidfd_send_signal`, `landlock_create_ruleset`. This is the only place `syscall()` is called.
- `src/probe/`: raw fact collection and JSON printing.
- `src/main.cpp`: mode dispatch only. `probe` is implemented; `run`, `serve`, `mcp`, `__cell`, `__init` print "not implemented in stage 0" to stderr and exit 64.
- GoogleTest unit-test harness and the unit tests listed in section 8.
- One libFuzzer target (JSON string escaper) so the `fuzz` preset has something to build.
- CI skeleton (`.github/workflows/ci.yml`): matrix of GCC and Clang, builds and tests presets. Skeleton only; it is not run in this stage.
- `docs/` skeleton: `STAGES.md`, `SETUP-WSL2.md`, `adr/0000-template.md`, `reports/`, `prompts/`.

Out of scope (and the stage that covers it):

- Creating any namespace, cell, cgroup, mount or overlay for real (Stage 1 onward). The one exception is the probe's throwaway user-namespace attempt in a forked child (section 4).
- Isolation level computation and receipts (Stage 2). Manifest, policy, seccomp, Landlock use (Stage 4). `libseccomp` linkage (Stage 4). `nlohmann/json` and JSON *parsing* (Stage 1, when `aegis run` first needs input). `rsync` (Stage 3). Escape probes (the corpus starts at Stage 1).

## 4. Design

**Result type.** C++20 has no `std::expected`, and CLAUDE.md §2 allows it only via ADR. `Result<T>` is a small `std::variant`-based type holding either `T` or `Error{int errno_value, std::string context}`; `[[nodiscard]]`; `Result<void>` supported. No exceptions on the Result path.

**Syscall wrappers.** Thin, typed, return `Result<T>`, no logic beyond argument marshalling and `EINTR` handling where retrying is semantically safe. Declared in `src/sys/syscalls.hpp`. Struct definitions for `clone_args` and `open_how` are taken from `<linux/sched.h>` / `<linux/openat2.h>` if present, otherwise declared locally with a comment naming the man page; hypothesis to confirm at build time.

**Probe: facts only.** Each fact is recorded as `{ "value": ..., "source": "<file or syscall>", "errno": <int or null> }` so failures are visible, not hidden. All reads are read-only and side-effect-free:

| Fact | Source |
| --- | --- |
| kernel release/version, architecture | `uname(2)`, `/proc/version` |
| WSL marker | `/proc/sys/kernel/osrelease` (informational only; never used to infer support, per §3.1) |
| user namespaces limit | `/proc/sys/user/max_user_namespaces` |
| unprivileged userns creation actually works | `fork()` a child that calls `unshare(CLONE_NEWUSER)` and exits; parent reports the child's result. Probe is single-threaded (§5.2). |
| `clone3` implemented | call with `size=0`; `EINVAL` means present, `ENOSYS` means absent |
| `openat2` / `RESOLVE_BENEATH` | call with `RESOLVE_BENEATH` on `.`; success/errno |
| `pidfd_open` | on own PID |
| Landlock ABI version | `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)` |
| seccomp, no_new_privs state | `/proc/self/status`, `prctl(PR_GET_NO_NEW_PRIVS)` (read only; nothing is set) |
| cgroup v2 mounted | `/proc/self/mountinfo` |
| cgroup path of this process, delegated controllers, writability of own subtree | `/proc/self/cgroup`, `<mount>/<path>/cgroup.controllers`, `cgroup.subtree_control`, `access(W_OK)` |
| overlayfs available | `/proc/filesystems` |
| working directory filesystem type | `statfs(2)` of CWD (flags `/mnt/c`-style 9p/drvfs per §3) |
| Windows interop visible | existence of `/proc/sys/fs/binfmt_misc/WSLInterop*` and `/mnt/c` (fact only) |

Not probed yet because they require a real cell and belong to Stage 1/2: unprivileged overlay mount inside a userns, `CLONE_INTO_CGROUP`, `cgroup.kill`, `memory.peak` (the latter two are reported only as file existence if a delegated subtree is found).

**Contributions preserved.** None of the five are implemented here; Stage 0 adds nothing that weakens them. The probe's "facts with source and errno" shape is chosen so Stage 2's fail-closed receipt can be built from it without re-probing differently.

**Alternatives considered.** FetchContent for GoogleTest/nlohmann (rejected: network at build time, §6.6). Hand-rolled JSON writer instead of vendoring nlohmann now (chosen: no new dependency until it is needed for parsing).

## 5. Files

New (all paths relative to the repository root; ~1,500 lines total expected):

| File | Purpose |
| --- | --- |
| `CMakeLists.txt`, `CMakePresets.json` | build, presets, flags, tests, fuzz target |
| `.clang-format`, `.clang-tidy`, `.gitignore` | style, lint, ignores |
| `.github/workflows/ci.yml` | CI skeleton |
| `src/main.cpp` | mode dispatch |
| `src/util/result.hpp` | `Result<T>`, `Error` |
| `src/util/fd.hpp`, `fd.cpp` | `UniqueFd` (O_CLOEXEC discipline, close with EINTR rules) |
| `src/util/json_writer.hpp`, `json_writer.cpp` | emit-only JSON, string escaping |
| `src/sys/syscalls.hpp`, `syscalls.cpp` | typed syscall wrappers |
| `src/probe/probe.hpp`, `probe.cpp` | fact collection and JSON output |
| `tests/unit/*.cpp` | unit tests (section 8) |
| `tests/fuzz/fuzz_json_escape.cpp` | libFuzzer target |
| `docs/STAGES.md`, `docs/SETUP-WSL2.md`, `docs/adr/0000-template.md`, `docs/reports/.gitkeep` | docs skeleton |

Modified: none (the repository currently contains only `CLAUDE.md`).

## 6. Dependencies and privileged actions

New libraries: **GoogleTest only** (required by §2 for tests). Consumed via `find_package(GTest)` from the system package; no network fetch.

Packages the owner installs (Ubuntu on WSL2; I will not run these):

```text
sudo apt install build-essential cmake ninja-build clang clang-tidy clang-format libgtest-dev
```

`libFuzzer` ships with Clang; if the `fuzz` preset fails to link, the matching `libclang-rt-<version>-dev` package may be needed (hypothesis, to be confirmed at build time; reported if so). `libseccomp-dev` and `rsync` are intentionally **not** needed yet.

Privileged actions (`sudo`, `wsl.conf`, systemd, cgroup ownership): **None** by Claude. The `apt` command above is the owner's one-time setup and will be recorded in `docs/SETUP-WSL2.md`.

## 7. Step-by-step plan

1. Initialise repo layout and docs skeleton; create `.clang-format`, `.clang-tidy`, `.gitignore`.
2. CMake project and presets; empty `main.cpp` builds in all four presets.
3. `Result<T>`, `UniqueFd`, JSON writer, with unit tests (written with the code).
4. `src/sys/` wrappers; compile-only plus the probe exercises them.
5. Probe facts one group at a time (kernel/identity, namespaces/syscalls, cgroup, filesystems), each with a unit test for its parser using canned `/proc` text.
6. `main.cpp` dispatch; `aegis probe` end to end.
7. Fuzz target; `fuzz` preset builds and runs.
8. CI skeleton.
9. Run `debug-asan`, `debug-tsan`, `release`, `fuzz`; clang-tidy; clang-format; write `docs/reports/stage-0.md` with measured results.

## 8. Tests and acceptance gate

Unit tests (GoogleTest): `Result` value/error/void paths; `UniqueFd` ownership, move, close-on-destroy, no double close; JSON writer escaping (quotes, backslash, control chars, invalid UTF-8 handling), nesting and comma placement; probe parsers (`mountinfo`, `/proc/self/cgroup`, `/proc/filesystems`, `/proc/self/status`) against canned fixtures; probe smoke test (runs, emits a JSON object containing every documented key, **asserts nothing about feature support**).

Escape probes: **none** in Stage 0 (the corpus starts when cells exist).

Gate, all measured and recorded in the report:

1. Builds with `-Werror` and the §2.1 flags in `debug-asan`, `debug-tsan`, `release`, `fuzz`, under both GCC and Clang (versions recorded).
2. `ctest` green in `debug-asan` and `release` (and `debug-tsan` runs clean).
3. `aegis probe` exits 0 on the owner's machine and prints valid JSON (checked with a JSON parser, not by eye); output pasted into the report.
4. `clang-tidy` and `clang-format --dry-run` clean.
5. The `release` binary: result of `ldd`/`file` recorded; static linking attempted per §2.1 and any failure documented as a deviation.
6. Fuzz target runs for a fixed 60 s with no crash; execution count recorded.
7. No file outside the repository was touched; no `sudo` run by Claude.

## 9. Risks and mitigations

- **Repo on `/mnt/c`**: CLAUDE.md §3 forbids building there; the current checkout is under a Windows path. Mitigation: open question 2; no build is run until the owner confirms a Linux-filesystem location.
- **Static glibc linking** may warn or fail for some functions (NSS). Mitigation: avoid NSS functions; record any deviation rather than dropping `-static` silently.
- **`clone3`/`openat2` headers** may be missing or older on the toolchain. Mitigation: local struct definitions with a man-page reference.
- **WSL2 kernel lacks a feature**: the probe reports the errno; it never fails. Tests assert shape, not support.
- **`libFuzzer` not installed**: `fuzz` preset fails at configure with a clear message; reported, owner installs the package.
- **clang-tidy noise**: a justified `NOLINT` needs a comment; no blanket check disabling without noting it in the report.

## 10. Rollback

All changes are new files on branch `stage/0-scaffold`. Back out by deleting the branch or `git revert`. No cgroups, mounts or system state are created in this stage, so there is nothing else to clean up.

## 11. Open questions for the owner

1. **`docs/BLUEPRINT.md` is missing.** Provide a copy, or confirm Stage 0 may proceed from CLAUDE.md alone.
2. **Repository location.** This checkout is on a Windows drive (`C:\Users\navas\Downloads\...`), which is `/mnt/c` from WSL. Should I develop here and you sync/build in `~/aegis-engine`, or will you move the repository to the WSL ext4 filesystem first?
3. **Git.** The directory is not a git repository. May I `git init` and create branch `stage/0-scaffold` (§10 requires one branch per stage)?
4. **CI provider.** GitHub Actions assumed for the skeleton. Correct?
5. **JSON writer vs nlohmann/json now.** Proposed: hand-rolled emit-only writer in Stage 0, vendor nlohmann/json in Stage 1. Acceptable?
6. **Probe's userns attempt.** The probe forks a child that calls `unshare(CLONE_NEWUSER)` and exits, to answer "does it really work" rather than reading a sysctl. This goes slightly beyond "raw facts" but has no side effects. Keep it?
