# ADR 0004: Overlay upper and work directories share one host bind mount

- Status: accepted (design consequence found by the Stage 3 spike and implementation, within the approved Stage 3 prompt's goal)
- Date: 2026-10-11
- Overrides: Stage 3 prompt section 4.3 (`upperdir=/workspace-upper,workdir=/workspace-work` as two binds)

## Context

The approved prompt had the control plane create three host directories (`lower`, `upper`, `work`)
and bind each into the cell, so that the overlay's changes would be readable by the host after the
cell's mount namespace is gone. The first end-to-end run fell back to copy mode with
`overlay fail 22` (`EINVAL`). A native reproduction in a real cell isolated it: binding two
different host directories separately for `upperdir` and `workdir` fails with `EINVAL` even though
both are on the same filesystem, while an overlay whose upper and work are plain subdirectories of
one bind mount works. overlayfs requires them to be reachable without crossing a mount boundary.

## Decision

The control plane creates one host directory `rw` holding `upper/` and `work/`, binds it once at
`/workspace-rw`, and mounts `upperdir=/workspace-rw/upper,workdir=/workspace-rw/work`. The launch
spec carries `lower` and `rw` (two paths, not three). `/workspace` is additionally a bind of
`rw/upper` so the copy-mode fallback writes into the same host-visible directory.

## Consequences

- The host reads the change set directly from `<workspace>/rw/upper` after the cell exits; no
  confined read-back is needed for the engine's own directories.
- The kernel-created `rw/work/work` has mode 0000. A recursive remove that `readdir`s it fails with
  `EACCES`, so `discard` restores its mode before removing the directory; this was found by test.
- The spec protocol is one key smaller; the parser enforces both-or-neither of `lower` and `rw`.
- Contribution 1 (diff-then-commit) is unchanged: the upper layer is still the exact change set.
