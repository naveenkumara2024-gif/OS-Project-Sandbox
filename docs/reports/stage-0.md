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

1. Branch `stage/0-scaffold` is based on `main` `a3ddec7`; merging is the owner's decision.
2. Stage 2 will need cgroup delegation (`cgroup.procs` is not writable by the user today); see
   `docs/SETUP-WSL2.md`.
