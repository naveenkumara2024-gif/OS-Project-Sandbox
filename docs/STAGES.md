# Stage state

Single source of truth for stage state (CLAUDE.md §0.1). Statuses: `planned`, `implement`, `prompt-drafted`, `approved`, `in-progress`, `verifying`, `done`, `blocked`.

| # | Stage | Status | Prompt | Report | Notes |
| --- | --- | --- | --- | --- | --- |
| 0 | Scaffold | prompt-drafted | [stage-0-scaffold.md](prompts/stage-0-scaffold.md) | | TypeScript + native helper variant. Awaiting owner approval; 6 open questions in prompt section 11 |
| 1 | Core cell | planned | | | |
| 2 | Limits and receipts | planned | | | |
| 3 | Workspace | planned | | | |
| 4 | Hardening | planned | | | |
| 5 | Integration | planned | | | |
| 6 | Evaluation | planned | | | |

## Log

- 2026-10-11: Owner asked to start the first stage. C++ Stage 0 prompt drafted (`stage-0-scaffold-cpp.md`). Stage 0 -> `prompt-drafted`. `docs/BLUEPRINT.md` not present.
- 2026-10-11: Owner asked to switch the project to TypeScript. Chosen: TypeScript control plane on Node.js LTS with a small native C helper (ADR 0001). CLAUDE.md rewritten. C++ Stage 0 prompt marked `superseded`; new TypeScript Stage 0 prompt drafted (`status: draft`). Stage 0 remains `prompt-drafted`; the earlier "proceed" was not an approval (CLAUDE.md §0.4).
- 2026-10-11: Owner added a git rule: each stage is committed on its own branch `stage/<N>-<slug>` when done, and any later fix for that stage is committed on the same branch. Added to CLAUDE.md §0.3, §0.6 item 7, new §0.8, §10, §12; Stage 0 prompt step 10 and gate item 7 updated (prompt still `draft`, not yet approved).
