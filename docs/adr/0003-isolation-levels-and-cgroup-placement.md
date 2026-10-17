# ADR 0003: Isolation levels, and cgroup placement without systemd-run per cell

- Status: accepted (owner approved the Stage 2 prompt, 2026-10-11)
- Date: 2026-10-11
- Overrides: Blueprint "cgroup v2 without root" (launch each cell through `systemd-run --user --scope -p MemoryMax=...`) and its "fallback to rlimits only"; defines the isolation level the blueprint uses but never specifies

## Context

The blueprint launches every cell through `systemd-run --user --scope` with properties for the
limits, and falls back to rlimits when no cgroup can be had. Two things were measured on the
owner's WSL2 machine (kernel `6.18.33.2-microsoft-standard-WSL2`, systemd is PID 1):

- `user@1000.service` already delegates `cpu memory pids` to the user, so no `sudo` and no
  `user@.service.d` drop-in is needed.
- `clone3(CLONE_INTO_CGROUP)` and a `cgroup.procs` write succeed from inside a user scope and fail
  with `EACCES` from `/init.scope` (where a plain `wsl.exe` shell lives): the kernel requires
  write access to the lowest common ancestor of the source and destination cgroups.

The blueprint also reports an "isolation level" (its example shows 4) without defining it.

## Decision

1. **The engine runs inside a delegated subtree and creates cell cgroups itself.** It creates a
   process-free `aegis-cells` parent below the highest cgroup it owns, enables `+cpu +memory
   +pids` there, and makes one leaf per cell. The helper is created inside the leaf with
   `CLONE_INTO_CGROUP`, so a cell is never outside its limits. Limits are written as cgroup files
   and read back (CLAUDE.md 6.1 item 6); kill is `cgroup.kill`. Not `systemd-run` per cell: that
   adds D-Bus and unit-lifecycle latency per run, delegates teardown to systemd, and hides the
   counters the classifier needs behind a second manager.
2. **Outside a delegated subtree the run is refused**, with `isolation_unavailable
   (cgroup_placement)` and the command to start the engine in a scope. There is no rlimit
   fallback: a silently weaker cell contradicts contribution 2 (CLAUDE.md 1.2).
3. **Level = the number of consecutive satisfied tiers**, each tier a fixed set of layers that the
   helper or the control plane actually observed:

   | Tier | Layers | Stage |
   | --- | --- | --- |
   | 1 | `userns pidns mountns netns root proc dev` | 1 |
   | 2 | `ipcns utsns cgroupns timens init cgroup_memory cgroup_pids` | 2 |
   | 3 | overlay workspace | 3 |
   | 4 | capability drop, `no_new_privs`, seccomp | 4 |

   `cgroup_cpu`, `cgroup_kill` and (Stage 4) `landlock` are reported but belong to no tier (CPU
   delegation is optional on other machines; the kill has a per-pid fallback; a kernel without
   Landlock must still be able to reach level 4, and a manifest that wants it can `require` it). A
   later stage adds its layers to the next tier; it never renumbers an existing one.

   Tier 4 was filled in by Stage 4 (`caps_dropped`, `no_new_privs`, `seccomp`). Because the tiers
   are consecutive, a run reaches level 4 only if tier 3 (`overlay`) is also satisfied, so a run
   without a workspace reports level 2 even though its payload is fully hardened. The receipt's
   `layers` object always shows the individual layers; the open question of whether the level
   should count only the tiers a run attempted is recorded in the Stage 4 report.

## Consequences

- No privileged setup, no systemd configuration change. The one operational requirement is that
  the engine (and the test suite) is started with `systemd-run --user --scope`; `npm test` does
  this through `scripts/run-in-scope.mjs`. Whether the engine should re-execute itself into a scope
  is deferred to Stage 5, where the MCP launch is decided.
- On a machine without systemd user delegation Stage 2 refuses every run. That is the intended
  failure mode, and the receipt says why.
- The level is comparable between runs and machines, and a harness can require a minimum.
- Contribution 2 is strengthened (a cell cannot start without verified limits). Contribution 3
  gains kernel-counter evidence (`memory.events`, `pids.events`, `cpu.stat`). Others unchanged.
