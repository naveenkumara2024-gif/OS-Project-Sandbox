# Stage state

Single source of truth for stage state (CLAUDE.md §0.1). Statuses: `planned`, `implement`, `prompt-drafted`, `approved`, `in-progress`, `verifying`, `done`, `blocked`.

| # | Stage | Status | Prompt | Report | Notes |
| --- | --- | --- | --- | --- | --- |
| 0 | Scaffold | done | [stage-0-scaffold.md](prompts/stage-0-scaffold.md) | [stage-0.md](reports/stage-0.md) | All gate items met and measured on WSL2 (see report). Branch `stage/0-scaffold` |
| 1 | Core cell | done | [stage-1-core-cell.md](prompts/stage-1-core-cell.md) | [stage-1.md](reports/stage-1.md) | Gate met and measured on WSL2: probes 1, 3, 5, 11 stopped on release and debug-asan; `npm run check` 202 tests; fuzz 130M execs, no crash. Branch `stage/1-core-cell`. Not a finished boundary until Stage 4 (report: what a payload can still do) |
| 2 | Limits and receipts | done | [stage-2-limits-and-receipts.md](prompts/stage-2-limits-and-receipts.md) | [stage-2.md](reports/stage-2.md) | Gate met and measured on WSL2: probes 7, 8, 9, 10, 17, 18 stopped on release and debug-asan; `npm run check` 268 tests; fuzz 145M execs, no crash. Branch `stage/2-limits-and-receipts`. Needs the engine inside a delegated scope; payload still uid 0 until Stage 4 |
| 3 | Workspace | planned | | | |
| 4 | Hardening | planned | | | |
| 5 | Integration | planned | | | |
| 6 | Evaluation | planned | | | |

## Log

- 2026-10-11: Owner asked to start the first stage. C++ Stage 0 prompt drafted (`stage-0-scaffold-cpp.md`). Stage 0 -> `prompt-drafted`. `docs/BLUEPRINT.md` not present.
- 2026-10-11: Owner asked to switch the project to TypeScript. Chosen: TypeScript control plane on Node.js LTS with a small native C helper (ADR 0001). CLAUDE.md rewritten. C++ Stage 0 prompt marked `superseded`; new TypeScript Stage 0 prompt drafted (`status: draft`). Stage 0 remains `prompt-drafted`; the earlier "proceed" was not an approval (CLAUDE.md §0.4).
- 2026-10-11: Stage 0 prompt **approved** by the owner (explicit "Approved" answer to "Do you approve the Stage 0 prompt as written?"). Approved SHA-256 `ba14a95a7d0abad6b9d80ed37ae5a6cc56d61346ed69ec1e1d7148ec07be4b5a`, computed over the file as committed on `main` (commit a3ddec7) with `status: draft` and empty `approved_at`/`approved_sha256`. To verify: restore those three front-matter values to the draft form and hash (LF line endings). Stage -> `approved` -> `in-progress`; branch `stage/0-scaffold` created from `main`.
- 2026-10-11: Owner decisions on open questions: write files in this directory and build/verify in WSL2 (Claude cannot run the native build or probe here, so the stage will stop at `verifying` until the owner reports measured results); `git init` already done by the owner; baseline commit made on `main`. `docs/AegisEngine R and D Blueprint.docx` read; no conflict with the prompt; deviations from the blueprint are listed in ADR 0001.
- 2026-10-11: Stage 0 implementation written on `stage/0-scaffold` (config, utilities, bounded runner, procfs parsers, native helper skeleton, helper client, probe, CLI, tests, CI skeleton, docs). Stage -> `verifying`. Nothing was built or executed by Claude (shell is on Windows; building under `/mnt/c` is forbidden), so the report lists every gate item as pending. `package.json` has no dependency versions and there is no lockfile until the owner runs the install in `docs/SETUP-WSL2.md`.
- 2026-10-11: Owner added a git rule: each stage is committed on its own branch `stage/<N>-<slug>` when done, and any later fix for that stage is committed on the same branch. Added to CLAUDE.md §0.3, §0.6 item 7, new §0.8, §10, §12; Stage 0 prompt step 10 and gate item 7 updated (prompt still `draft`, not yet approved).

- 2026-10-11: Verification run in WSL2. Fixed duplicate `_GNU_SOURCE` (blocked every native build), two tsc errors, prettier and clang-tidy config. Stage stays `verifying`: Vitest cannot run (Windows-installed `node_modules`) and `npm ci` was not run; details in `docs/reports/stage-0.md`.

- 2026-10-11: Owner switched to Linux npm. `npm ci --ignore-scripts` and `npm run check` pass (6 files, 52 tests), `npm audit` 0 vulnerabilities. Remaining gate gap: Clang `debug-asan` link (missing `libclang-rt`). Stage stays `verifying`.

- 2026-10-11: Owner installed `libclang-rt-21-dev`; Clang `debug-asan` builds and probes cleanly. Last gate item met. Stage 0 -> `done`. Waiting on owner to set Stage 1 to `implement`.

- 2026-10-11: Pre-Stage-1 audit (owner asked to confirm Stage 0 is complete). Stage 0 set to `in-progress` per CLAUDE.md 0.8 and back to `done`: restored the Results section of the report (lost in `6013881`), added the full probe JSON, and corrected `docs/SETUP-WSL2.md` (Linux npm check, Clang sanitizer runtime, lockfile install). Documentation only; no code changed.

- 2026-10-11: Owner asked to implement the next stage after confirming Stage 0 is complete. Stage 0 audit done (see the entry above). Stage 1 prompt drafted at `docs/prompts/stage-1-core-cell.md` (`status: draft`). Stage 1 -> `prompt-drafted`. No implementation file created; waiting for explicit approval (CLAUDE.md 0.3 step 5).

- 2026-10-11: Owner answered the five open questions (recommended options) and then approved the Stage 1 prompt (explicit "approved" answer to "Do you approve the Stage 1 prompt as written?"). Approved SHA-256 `fe8456ac2a7f3063d81568852a7ef1cc8db2981e3edbe92eb219c65c616c556e`, computed over the file with `status: draft` and empty `approved_at`/`approved_sha256` (same convention as Stage 0). Stage -> `approved` -> `in-progress`; branch `stage/1-core-cell` created from the tip of `stage/0-scaffold` (`3b8dcc3`).

- 2026-10-11: Stage 1 step 1 spike run (scratchpad, unprivileged). All namespace and mount hypotheses confirmed, but a recursive bind of `/usr` also copies WSL's 9p `drivers`, overlay `gpu lib` and overlay `modules` mounts into the cell (non-recursive bind and umount both fail with EINVAL). Per CLAUDE.md 0.5 an amendment (composite bind planned in TypeScript, verified in C) was appended to the Stage 1 prompt, its approval is void and the stage is back to `prompt-drafted`. No implementation file was written.

- 2026-10-11: Owner approved the Stage 1 prompt including Amendment 1 (a first "proceed" was not approval; the explicit "Approved" answer to "Do you approve the Stage 1 prompt as written, including Amendment 1?" was). Approved SHA-256 `3dc1965f03f055b88d9718a741a04744377e458e2bfa3f5c1c797f7621281b1e`, computed over the file with `status: draft` and empty `approved_at`/`approved_sha256`. Stage -> `approved` -> `in-progress` on `stage/1-core-cell`. Step 1 (spike) done; continuing at step 2.

- 2026-10-11: Stage 1 implemented on `stage/1-core-cell` and verified (see `docs/reports/stage-1.md`): composite `/usr` bind (ADR 0002), `aegis-cell boot`, `aegis run`, probes 1, 3, 5, 11 stopped, 202 tests passing, 130,234,391 fuzz executions without a crash. Stage 1 -> `done`. Waiting on owner to set Stage 2 to `implement`.

- 2026-10-11: Owner asked to proceed with Stage 2 and said the prompt is pre-approved. A pre-approval cannot cover text the owner has not seen (CLAUDE.md 0.4), so the gate procedure was followed: Stage 2 prompt drafted at `docs/prompts/stage-2-limits-and-receipts.md` (`status: draft`), Stage 2 -> `prompt-drafted`. Facts measured first: `user@1000.service` already delegates `cpu memory pids` to the user; `CLONE_INTO_CGROUP` works from inside a `systemd-run --user --scope` and fails with EACCES from `/init.scope`. No implementation file written; waiting for explicit approval of the prompt.

- 2026-10-11: Owner approved the Stage 2 prompt (a first "proceed" was not approval; the explicit "Approved" answer to "Do you approve the Stage 2 prompt as written?" was, with the recommended answers to the six open questions already reflected in the design sections). Approved SHA-256 `d31171cd1a4af06576a40a7b57983bceca7e74e241a26bee04b3c04f9330c6a9`, computed over the file with `status: draft` and empty `approved_at`/`approved_sha256`. Stage -> `approved` -> `in-progress`; branch `stage/2-limits-and-receipts` created from `main` (`e4dc425`).

- 2026-10-11: Stage 2 implemented on `stage/2-limits-and-receipts` and verified (see `docs/reports/stage-2.md`): per-cell cgroup limits with `CLONE_INTO_CGROUP`, `aegis-cell init` as PID 1, full classifier and receipt, ADR 0003. Probes 7, 8, 9, 10, 17, 18 stopped; 268 tests passing (3 consecutive full runs, 12 consecutive escape runs); 145,288,926 fuzz executions without a crash. Two classifier races found by the repeat runs were fixed before done. Stage 2 -> `done`. Waiting on owner to set Stage 3 to `implement`.
