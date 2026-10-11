# Stage 0 report: Scaffold

- Branch: `stage/0-scaffold`, created from `main` at `a3ddec7`.
- Prompt: `docs/prompts/stage-0-scaffold.md`, approved 2026-10-11, SHA-256
  `ba14a95a7d0abad6b9d80ed37ae5a6cc56d61346ed69ec1e1d7148ec07be4b5a`.
- **Status: PARTIALLY VERIFIED (2026-10-11, WSL2, Node 22.22.1).** Everything except Vitest, the
  `npm ci` gate item and the Clang ASan build has been run and is recorded under "Results". Stage 0
  stays `verifying` until the Linux-side install is redone and `npm run check` runs end to end.

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

1. **No dev dependency versions in `package.json`, no `package-lock.json`.** Versions must not be
   guessed (CLAUDE.md 11) and Claude cannot run `npm install` on `/mnt/c`. The owner runs the
   documented install, which pins exact versions and creates the lockfile. Gate item 1 (`npm ci`)
   therefore cannot pass until that is done and committed.
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

## Open questions

1. Which Node.js version is installed in the WSL2 distribution? (recorded once the probe runs)
2. After the install, commit `package.json` and `package-lock.json` yourself, or should Claude?

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
15.2.0, Clang 21.1.8, Node 22.22.1. **Environment problem:** `npm` on `PATH` is the Windows
`npm` (`/mnt/c/Program Files/nodejs`); the Linux Node (`/usr/bin/node`) has no npm. The existing
`node_modules` and `package-lock.json` were therefore created by Windows npm, `node_modules` holds
`@rolldown/binding-win32-x64-msvc` only, and `npm run` fails (cmd.exe cannot use a UNC cwd). The
TypeScript tools were run directly with `node node_modules/<tool>` instead.

| Gate item | Result |
| --- | --- |
| `npm ci --ignore-scripts` from lockfile | **not run** (no Linux npm; see above) |
| `tsc --noEmit` | pass after fix 2 (2 errors before) |
| `eslint --max-warnings 0 .` | pass |
| `prettier --check .` | pass after fix 4 (3 files before) |
| `vitest run` | **fails to start**: rolldown has no Linux binding in the Windows-installed `node_modules`. Tests have not run. |
| Native `release` + `debug-asan`, `-Werror`, GCC | pass after fix 1 (both fail before); release is `static-pie` |
| Native `release`, `-Werror`, Clang | pass (static-pie) |
| Native `debug-asan`, Clang | **fails to link**: `libclang_rt.asan*.a` missing under `/usr/lib/llvm-21`; needs the owner to install the Clang runtime package |
| `file` / `ldd` of release helper | ELF 64-bit PIE, static-pie linked; `ldd`: statically linked |
| debug-asan helper `probe` run | output identical to release, no sanitizer report on stderr |
| `clang-format --dry-run`, `clang-tidy` | both clean after fix 3 |
| `aegis probe` (built via `tsc -p tsconfig.build.json`, run as `node dist/main.js probe`) | exit 0, helper found and available, full JSON below |
| Dependencies | 156 packages in lockfile, all `dev`, 27 optional (platform binaries), all resolved from `registry.npmjs.org`; only install script: `fsevents` (macOS-only optional). `npm audit` **not run** |

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

1. Install a Linux npm (for example `sudo apt install npm`, or Node from NodeSource/nvm) and put it
   ahead of `/mnt/c/...` on `PATH` (or set `[interop] appendWindowsPath=false` in `/etc/wsl.conf`).
   Then: `rm -rf node_modules && npm ci --ignore-scripts && npm run check && npm audit`. Claude must
   not run the `sudo`/`wsl.conf` step (CLAUDE.md 6.6).
2. Install the Clang ASan runtime (`libclang-rt-21-dev`) if Clang ASan coverage is wanted; GCC ASan
   is already covered.
