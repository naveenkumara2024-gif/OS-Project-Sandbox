# Stage 0 report: Scaffold

- Branch: `stage/0-scaffold`, created from `main` at `a3ddec7`.
- Prompt: `docs/prompts/stage-0-scaffold.md`, approved 2026-10-11, SHA-256
  `ba14a95a7d0abad6b9d80ed37ae5a6cc56d61346ed69ec1e1d7148ec07be4b5a`.
- **Status: DONE (2026-10-11, WSL2, Node 22.22.1, npm 9.2.0).** All gate items in "Results" are
  measured. Branch `stage/0-scaffold`; this report is in the final commit, whose parent is
  `6013881` (`git log -1` on the branch shows the tip).

## What changed

| Area | Files |
| --- | --- |
| TypeScript project | `package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `vitest.config.ts`, `.gitignore`, `.gitattributes` |
| Utilities | `src/util/result.ts` (`Result`, errno codes), `src/util/fd.ts` (`OwnedFd`) |
| Child I/O | `src/sys/run-bounded.ts` (argv, explicit env, timeout, output caps, no shell) |
| Helper client | `src/sys/helper.ts` (locate helper, run `probe`, validate exact output shape) |
| Probe | `src/probe/procfs.ts` (pure parsers), `src/probe/probe.ts` (aggregation, fact shape) |
| CLI | `src/main.ts` (`probe` implemented; `run`, `serve`, `mcp` exit 64) |
| Native helper | `native/src/{main,sys,probe}.{c,h}`: `aegis-cell probe` only |
| Tooling | `scripts/build-native.mjs`, `scripts/check-native.mjs`, `.clang-format`, `.clang-tidy`, `.github/workflows/ci.yml` |
| Docs | `docs/SETUP-WSL2.md`, `docs/adr/0000-template.md`, `docs/reports/` |
| Tests | `tests/unit/{result,fd,run-bounded,procfs,helper,probe}.test.ts` |

## Deviations from the prompt

1. **Dependency versions were added after the code, not before.** Versions must not be guessed
   (CLAUDE.md 11), so the first commits had none; the owner ran the install and the pins and lockfile
   were committed in `1cf8536`. Resolved by the time of the Results below.
2. **Files not listed in the prompt:** `tsconfig.build.json` (emit `src/` only, so tests are not
   built into `dist/`), `.prettierignore`, `.gitattributes` (LF line endings so approval hashes and
   the lockfile are identical on Windows and WSL), `scripts/check-native.mjs` (runs clang-format and
   clang-tidy by argument vector). All are configuration, none adds behaviour.
3. **Core ESLint rules** are enabled one by one instead of importing `@eslint/js`, which is not in
   the approved dependency list.
4. **`aegis probe` exit status:** 0 whenever a report is produced, including when the helper is
   missing (that is reported as `native.helper_available: false`), as the prompt specified.

## Known limitations and risks (unverified)

- Everything below is a hypothesis until the owner runs it: the TypeScript compiles under the strict
  flags; ESLint `strictTypeChecked` is clean at `--max-warnings 0` with the typescript-eslint version
  npm resolves; Prettier and clang-format accept the formatting as written; clang-tidy's `cert-*`
  set may need tuning; static linking succeeds on the owner's toolchain.
- Syscall numbers in `native/src/sys.c` (434, 435, 437, 444) are the unified numbers for x86-64 and
  arm64; the probe exercises them, so a wrong number would show as `ENOSYS` rather than pass silently.
- `unshare_newuser` runs a throwaway forked child; it has no side effect on the parent.

## Fixes made while verifying (all in Stage 0 scope)

1. `scripts/build-native.mjs`: removed `-D_GNU_SOURCE`; every `.c` file already defines it and
   `-Werror` rejected the redefinition, so no native build could succeed. `scripts/check-native.mjs`
   likewise.
2. `src/probe/probe.ts`: `process.getuid`/`getgid` are optional in `@types/node`; now `?.() ?? null`
   (tsc TS2722 at lines 287-288).
3. `.clang-tidy`: disabled `bugprone-reserved-identifier`/`cert-dcl51-cpp` (the required
   `_GNU_SOURCE`) and `clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling`
   (demands Annex K `memcpy_s`, absent from glibc; the calls are bounded). Reason is in the file.
4. Prettier reformatted `scripts/build-native.mjs`, `src/probe/probe.ts`, `src/util/result.ts`.

## Results

Commands were run from `~/aegis-engine` (ext4) in WSL2 `6.18.33.2-microsoft-standard-WSL2`, GCC
15.2.0, Clang 21.1.8, Node 22.22.1, npm 9.2.0. **Environment problem, resolved:** `npm` on `PATH`
was the Windows npm (`/mnt/c/Program Files/nodejs`) and `node_modules` had been installed by it
(win32 rolldown binding only, so Vitest could not start and `npm run` failed because cmd.exe cannot
use a UNC cwd). After the owner put the Linux npm 9.2.0 (`/usr/bin/npm`) first on `PATH`,
`rm -rf node_modules && npm ci --ignore-scripts` was run and every row below was re-measured with
`npm run check`.

| Gate item | Result |
| --- | --- |
| `npm ci --ignore-scripts` from lockfile | pass: 133 installed, 134 audited, lockfile unchanged (`git status` clean) |
| `npm run check` (tsc, eslint, prettier, vitest) | **pass**, exit 0 |
| `tsc --noEmit` | pass after fix 2 (2 errors before) |
| `eslint --max-warnings 0 .` | pass |
| `prettier --check .` | pass after fix 4 (3 files before) |
| `vitest run` | pass: 6 files, 52 tests, 0.94 s (vitest 5.0.3) |
| Native `release` + `debug-asan`, `-Werror`, GCC | pass after fix 1 (both fail before); release is `static-pie` |
| Native `release` + `debug-asan`, Clang 21.1.8, `-Werror` | pass after the owner installed `libclang-rt-21-dev` 1:21.1.8-6ubuntu1 (link failed before); binary has 172 `__asan` dynamic symbols; `probe` run exits 0, output identical to the GCC build, no sanitizer report |
| `file` / `ldd` of release helper | ELF 64-bit PIE, static-pie linked; `ldd`: statically linked |
| debug-asan helper `probe` run | output identical to release, no sanitizer report on stderr |
| `clang-format --dry-run`, `clang-tidy` | both clean after fix 3 |
| `aegis probe` (built via `tsc -p tsconfig.build.json`, run as `node dist/main.js probe`) | exit 0, helper found and available, full JSON below |
| Dependencies | 7 direct dev dependencies (exact pins: @types/node 26.6.5, eslint 10.12.0, fast-check 4.10.2, prettier 3.9.10, typescript 6.0.3, typescript-eslint 8.71.1, vitest 5.0.3); 156 packages in lockfile, all `dev`, 27 optional platform binaries, all from `registry.npmjs.org`; only install script `fsevents` (macOS-only, skipped by `--ignore-scripts`). `npm audit`: 0 vulnerabilities |

### `aegis probe` full output

Captured 2026-10-11 after the last commit with `node dist/main.js probe` (exit 0):

```json
{
  "schema": 1,
  "tool": "aegis",
  "generated_at": "2026-10-11T16:36:16.158Z",
  "facts": {
    "kernel.release": {
      "value": "6.18.33.2-microsoft-standard-WSL2",
      "source": "os.release()",
      "errno": null
    },
    "kernel.version": {
      "value": "Linux version 6.18.33.2-microsoft-standard-WSL2 (root@f1bbfb02316b) (gcc (GCC) 13.2.0, GNU ld (GNU Binutils) 2.41) #1 SMP PREEMPT_DYNAMIC Thu Jun 18 21:54:43 UTC 2026",
      "source": "/proc/version",
      "errno": null
    },
    "kernel.arch": {
      "value": "x64",
      "source": "os.arch()",
      "errno": null
    },
    "node.version": {
      "value": "22.22.1",
      "source": "process.versions.node",
      "errno": null
    },
    "process.uid": {
      "value": 1000,
      "source": "process.getuid()",
      "errno": null
    },
    "process.gid": {
      "value": 1000,
      "source": "process.getgid()",
      "errno": null
    },
    "wsl.osrelease_marker": {
      "value": true,
      "source": "/proc/sys/kernel/osrelease",
      "errno": null
    },
    "userns.max_user_namespaces": {
      "value": 30219,
      "source": "/proc/sys/user/max_user_namespaces",
      "errno": null
    },
    "cgroup2.mount_point": {
      "value": "/sys/fs/cgroup",
      "source": "/proc/self/mountinfo (fstype cgroup2)",
      "errno": null
    },
    "cgroup.self_path": {
      "value": "/init.scope",
      "source": "/proc/self/cgroup (0:: line)",
      "errno": null
    },
    "cgroup.v1_lines": {
      "value": 0,
      "source": "/proc/self/cgroup (v1 hierarchy lines)",
      "errno": null
    },
    "cgroup.controllers": {
      "value": [
        "cpu",
        "memory",
        "pids"
      ],
      "source": "/sys/fs/cgroup/init.scope/cgroup.controllers",
      "errno": null
    },
    "cgroup.subtree_control": {
      "value": [],
      "source": "/sys/fs/cgroup/init.scope/cgroup.subtree_control",
      "errno": null
    },
    "cgroup.own_dir_writable": {
      "value": false,
      "source": "access(/sys/fs/cgroup/init.scope/cgroup.procs, W_OK)",
      "errno": "EACCES"
    },
    "cgroup.kill_present": {
      "value": true,
      "source": "exists(/sys/fs/cgroup/init.scope/cgroup.kill)",
      "errno": null
    },
    "cgroup.memory_peak_present": {
      "value": true,
      "source": "exists(/sys/fs/cgroup/init.scope/memory.peak)",
      "errno": null
    },
    "fs.overlay_listed": {
      "value": true,
      "source": "/proc/filesystems",
      "errno": null
    },
    "cwd.statfs_type": {
      "value": 61267,
      "source": "statfs(cwd).type",
      "errno": null
    },
    "mnt_c.present": {
      "value": true,
      "source": "exists(/mnt/c)",
      "errno": null
    },
    "wsl.interop_entries": {
      "value": [
        "WSLInterop"
      ],
      "source": "/proc/sys/fs/binfmt_misc",
      "errno": null
    },
    "native.helper_path": {
      "value": "/home/naveen/aegis-engine/native/build/release/aegis-cell",
      "source": "repo:native/build/release",
      "errno": null
    },
    "native.helper_available": {
      "value": true,
      "source": "spawn aegis-cell probe",
      "errno": null
    },
    "native.clone3": {
      "value": true,
      "source": "syscall:clone3(size=0)",
      "errno": "EINVAL"
    },
    "native.openat2_resolve_beneath": {
      "value": true,
      "source": "syscall:openat2(.,RESOLVE_BENEATH)",
      "errno": null
    },
    "native.pidfd_open": {
      "value": true,
      "source": "syscall:pidfd_open(self)",
      "errno": null
    },
    "native.landlock_abi_version": {
      "value": 7,
      "source": "syscall:landlock_create_ruleset(VERSION)",
      "errno": null
    },
    "native.seccomp_mode": {
      "value": 0,
      "source": "prctl:PR_GET_SECCOMP",
      "errno": null
    },
    "native.no_new_privs": {
      "value": 0,
      "source": "prctl:PR_GET_NO_NEW_PRIVS",
      "errno": null
    },
    "native.unshare_newuser": {
      "value": true,
      "source": "fork+unshare(CLONE_NEWUSER)",
      "errno": null
    }
  }
}
```

### `aegis probe` facts that matter for later stages

- Kernel `6.18.33.2-microsoft-standard-WSL2`, x64, Node `22.22.1`, uid/gid 1000, `/mnt/c` present,
  `WSLInterop` registered in binfmt_misc (so cell isolation of interop will matter in Stage 4).
- `max_user_namespaces` 30219; helper: `unshare(CLONE_NEWUSER)` true, `clone3` reachable (EINVAL for
  size=0 is the expected "exists" answer), `openat2` `RESOLVE_BENEATH` true, `pidfd_open` true,
  Landlock ABI 7, `seccomp_mode` 0, `no_new_privs` 0.
- cgroup v2 at `/sys/fs/cgroup`, own cgroup `/init.scope` with controllers `cpu memory pids`,
  `cgroup.subtree_control` empty, **`cgroup.procs` not writable by the user (EACCES)**: no delegated
  subtree yet. `cgroup.kill` and `memory.peak` exist. Stage 2 needs the delegation in SETUP-WSL2.md.
- cwd filesystem magic 61267 (0xEF53, ext4). `overlay` is listed in `/proc/filesystems`; an actual
  unprivileged overlay mount is not probed until Stage 3.

## Open questions

1. Branch `stage/0-scaffold` is based on `main` `a3ddec7`; merging is the owner's decision (it was
   merged on GitHub as PR #1 after this report was written).
2. Stage 2 will need cgroup delegation (`cgroup.procs` is not writable by the user today); see
   `docs/SETUP-WSL2.md`.

## Fixes after done

### 2026-10-11: gaps found by the pre-Stage-1 audit (documentation only)

- **Issue:** (0) commit `6013881` accidentally truncated this report: the `Fixes made while
  verifying` and `Results` sections were lost from `6013881` through `fe5cd8a` (an editing mistake by
  Claude, restored here from `27650b3` and re-measured values); (a) gate item 4 asked for the full `aegis probe` output in the report and only a summary
  was there; (b) `docs/SETUP-WSL2.md` still said `package.json` lists no versions, omitted the Clang
  sanitizer runtime package, and did not warn that a Windows `npm` on `PATH` breaks the install;
  (c) deviation 1 above was stale.
- **Cause:** the report and setup guide were written before the owner's install and the verification
  run.
- **Change:** full probe JSON added to this report; setup guide updated (section 2, 3, 5); deviation 1
  reworded. No code changed.
- **Commands run:** `npm run build`, `node dist/main.js probe`, `npx prettier --check docs`.
