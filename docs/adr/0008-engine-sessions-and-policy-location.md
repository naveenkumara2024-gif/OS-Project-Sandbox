# ADR 0008: One engine for every front end, sessions, and the policy file's location

- Status: accepted (Stage 5 prompt sections 4.1, 4.2 and 4.8, and the owner's approval of item 2)
- Date: 2026-10-17
- Overrides: Stage 4's policy loading (which fell back to `policy.default.json` in the repository)

## Context

Stage 5 adds two front ends (an HTTP gateway and an MCP server) to the one-shot CLI. They must not
drift apart, and a multi-step task (write a file, run it, fix it) needs state between runs. Stage 3
kept a run's workspace under a caller-chosen id with no lifetime.

## Decision

- **One engine** (`src/engine/`) owns sessions, admission control, event streams and the calls to
  `runCell`. The gateway, the MCP server and the CLI are thin adapters. Two engines running at once
  (for example `aegis serve` and a harness's `aegis mcp`) keep separate in-memory tables and share
  nothing but the directories on disk.
- **A session is a workspace directory** `aegis-workspace-<id>` holding `lower`, `rw/{upper,work}` and
  `session.json` (strict schema, written by the control plane, read back through it). The gateway and
  MCP generate unguessable ids (`s-` and 128 bits); only the one-shot CLI uses the request id, so
  `aegis commit <id>` keeps working. One run at a time per session. Later runs may add files, written
  into the upper layer; a path whose target or parent is a symlink, a non-file or an overlay
  whiteout is refused (whiteouts and opaque directories were not measured, so they are not guessed
  at). Idle sessions expire; a startup sweep removes sessions whose owner process is dead and whose
  last use is old, and leaves anything without a valid `session.json` alone.
- **Commit is bound to the diff.** `commit` takes the SHA-256 of the canonical change list the
  approver saw; any difference refuses and returns the current diff. The destination is the session's
  own source, which must be inside a policy `commit_roots` entry.
- **The policy file lives outside the repository.** The engine reads `AEGIS_POLICY_FILE`, else
  `~/.config/aegis/policy.json`, and refuses to run without a valid one. The repository's
  `policy.default.json` is a template. In a harness setup the repository is the workspace the agent
  can write to, and the ceiling must not be (CLAUDE.md 6.4).
- **Cancellation** is a termination cause of its own (`cancelled`), produced by the same kill
  procedure as a timeout.

## Consequences

- A Stage 4 policy file is refused until it gains the Stage 5 ceiling keys. This is intended: a
  policy that does not say how many cells or sessions are allowed should not run.
- The sessions of a crashed engine are reclaimed after the idle time by the next engine that starts.
- Runs started through `aegis run` (the CLI) are sessions too, so the idle expiry applies to them.
- The human gate for `commit` remains the harness's permission prompt; the diff binding only ensures
  that what is applied is what was reviewed. An agent with an unrestricted same-user shell is outside
  what any of this can constrain, and `docs/INTEGRATION.md` says so.
