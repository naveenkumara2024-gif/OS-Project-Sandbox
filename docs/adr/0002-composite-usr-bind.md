# ADR 0002: Build the cell's /usr from leaf bind mounts, not one recursive bind

- Status: accepted (owner approved the Stage 1 prompt including Amendment 1, 2026-10-11)
- Date: 2026-10-11
- Overrides: Blueprint "The minimal root" (one read-only bind of `/usr`); Stage 1 prompt section 4.4 step 4 as first approved

## Context

The blueprint builds the cell root from a tmpfs plus a single read-only bind of the host `/usr`.
The Stage 1 spike (run unprivileged on kernel `6.18.33.2-microsoft-standard-WSL2`) showed that on
WSL2 the host's `/usr` has three filesystems mounted below it:

| Path | Filesystem | Content |
| --- | --- | --- |
| `/usr/lib/wsl/drivers` | 9p | the Windows driver store |
| `/usr/lib/wsl/lib` | overlay | GPU libraries |
| `/usr/lib/modules/<kernel>` | overlay | kernel modules |

A recursive bind (`MS_BIND|MS_REC`) copies all three into the cell. That puts Windows files inside
the cell, which CLAUDE.md 6.1 item 2 forbids. Measured alternatives on this kernel:

- non-recursive `MS_BIND` of `/usr`: `EINVAL` (the kernel will not bind a mount that has locked
  children without also copying them);
- `umount2` of the copied submounts: `EINVAL` (they are locked in the new mount namespace);
- over-mounting them with an empty tmpfs: works, but a payload holding `CAP_SYS_ADMIN` in its own
  user namespace (which it does until Stage 4) can unmount the tmpfs and reveal them. Rejected.

## Decision

The control plane reads the host mount table and `/usr` and emits an ordered list of leaf entries:
directories that contain no mount are bound whole, directories that do are created empty on the
tmpfs root and populated entry by entry (files bound individually, symlinks recreated), and the
mount points themselves are skipped. The helper executes the list, remounts every bind read-only,
`nosuid`, `nodev` preserving the kernel's locked flags, verifies the flags with `statvfs`, and then
re-reads the mount table and aborts if anything other than the planned mounts sits under the new
`/usr`. Planning is in TypeScript (policy as data); the helper has no directory-walking code on the
boot path.

Alternatives rejected: one recursive bind (leaks Windows files); a minimal root with a static
busybox (stricter, but needs a pinned verified static binary and is more work; the owner chose the
`/usr` approach for this stage); mounting the plan as an overlay (an overlay needs a writable
upper and does not remove submounts either).

## Consequences

- The cell has about 75 bind mounts on this machine instead of one (measured; the entry cap is 512
  and a larger plan is refused rather than truncated).
- The plan depends on the host layout and is computed per run; a host change between planning and
  boot fails closed in the helper's verification.
- Directories created empty by the plan (`/usr`, `/usr/lib`, ...) are on the cell's tmpfs and are
  writable inside the cell (size-capped, discarded with it).
- Contribution 2 (fail-closed receipts) is strengthened: `layer root ok` is written only after
  the mount table has been checked. Contributions 1, 3, 4 and 5 are unaffected.
- Still open until Stage 4: the host's `/usr` remains readable in full and the payload has
  namespace-local capabilities (prompt section 4.9).
