# Stage state

Single source of truth for stage state (CLAUDE.md §0.1). Statuses: `planned`, `implement`, `prompt-drafted`, `approved`, `in-progress`, `verifying`, `done`, `blocked`.

| # | Stage | Status | Prompt | Report | Notes |
| --- | --- | --- | --- | --- | --- |
| 0 | Scaffold | in-progress | [stage-0-scaffold.md](prompts/stage-0-scaffold.md) | | Approved 2026-10-11. Branch `stage/0-scaffold`. Owner builds and verifies in WSL2 (see log) |
| 1 | Core cell | planned | | | |
| 2 | Limits and receipts | planned | | | |
| 3 | Workspace | planned | | | |
| 4 | Hardening | planned | | | |
| 5 | Integration | planned | | | |
| 6 | Evaluation | planned | | | |

## Log

- 2026-10-11: Owner asked to start the first stage. C++ Stage 0 prompt drafted (`stage-0-scaffold-cpp.md`). Stage 0 -> `prompt-drafted`. `docs/BLUEPRINT.md` not present.
- 2026-10-11: Owner asked to switch the project to TypeScript. Chosen: TypeScript control plane on Node.js LTS with a small native C helper (ADR 0001). CLAUDE.md rewritten. C++ Stage 0 prompt marked `superseded`; new TypeScript Stage 0 prompt drafted (`status: draft`). Stage 0 remains `prompt-drafted`; the earlier "proceed" was not an approval (CLAUDE.md §0.4).
- 2026-10-11: Stage 0 prompt **approved** by the owner (explicit "Approved" answer to "Do you approve the Stage 0 prompt as written?"). Approved SHA-256 `ba14a95a7d0abad6b9d80ed37ae5a6cc56d61346ed69ec1e1d7148ec07be4b5a`, computed over the file as committed on `main` (commit a3ddec7) with `status: draft` and empty `approved_at`/`approved_sha256`. To verify: restore those three front-matter values to the draft form and hash (LF line endings). Stage -> `approved` -> `in-progress`; branch `stage/0-scaffold` created from `main`.
- 2026-10-11: Owner decisions on open questions: write files in this directory and build/verify in WSL2 (Claude cannot run the native build or probe here, so the stage will stop at `verifying` until the owner reports measured results); `git init` already done by the owner; baseline commit made on `main`. `docs/AegisEngine R and D Blueprint.docx` read; no conflict with the prompt; deviations from the blueprint are listed in ADR 0001.
- 2026-10-11: Owner added a git rule: each stage is committed on its own branch `stage/<N>-<slug>` when done, and any later fix for that stage is committed on the same branch. Added to CLAUDE.md §0.3, §0.6 item 7, new §0.8, §10, §12; Stage 0 prompt step 10 and gate item 7 updated (prompt still `draft`, not yet approved).
