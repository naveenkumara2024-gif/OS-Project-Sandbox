# ADR 0005: Hand-assembled seccomp filter instead of libseccomp

- Status: accepted (owner chose raw BPF when approving the Stage 4 prompt, 2026-10-17)
- Date: 2026-10-17
- Overrides: CLAUDE.md section 2 ("Native libraries: `libseccomp` (Stage 4, linked statically)")

## Context

CLAUDE.md lists `libseccomp` as the Stage 4 native library. On the owner's machine only the runtime
`libseccomp2` 2.6.0 exists: there is no `seccomp.h` and no `libseccomp.a`, so linking it statically
would need `sudo apt install libseccomp-dev` from the owner. The in-cell helper must be a static
binary that depends on nothing from the host (CLAUDE.md 2.1), and a new library is a new attack
surface and a new supply-chain item for a security tool.

The filter this project needs is small and fixed: an architecture check, a deny list of about 45
system calls, and three argument checks (`clone` flags, `ioctl` request, `personality` value). It
has no need for libseccomp's rule compiler, multiple architectures, or optimiser.

## Decision

`native/src/seccomp.c` assembles classic BPF directly from a static table, using only the kernel's
UAPI headers (`linux/filter.h`, `linux/seccomp.h`, `linux/audit.h`), and installs it with
`prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER)` after `no_new_privs` is set. Every rule is a compare
followed by a return, so no jump offset ever exceeds the 8-bit field and the program is linear
(116 instructions as measured). The architecture is checked first and a wrong architecture or the
x32 syscall space kills the process. The table covers `x86_64` only; on another architecture the
build produces a stub that fails (`ENOSYS`), so the `seccomp` layer is never reported and a run that
requires it is refused. The kernel's system call numbers come from `<sys/syscall.h>`, so a name that
the header lacks fails the build instead of being skipped.

The assembler is checked three ways: a table test that runs the assembled program through a small
reference evaluator (`native/src/test_filter.c`, run by `scripts/check-native.mjs` under ASan and
UBSan), a libFuzzer target that asserts the same properties on random system call numbers,
architectures and arguments (`native/src/fuzz_filter.c`), and integration tests and escape probes
that ask the real kernel.

## Consequences

- No new package, no `sudo`, no new link dependency. The static helper is unchanged in kind.
- The project owns the table. A dangerous system call that a future kernel adds is allowed until
  someone lists it (this is true of any deny list; stated in the Stage 4 report).
- Only `x86_64` is supported for seccomp. WSL2 on ARM would need its own numbers; the helper
  refuses to claim the layer there rather than guess.
- The numbers in the table come from the headers, but the *decisions* in it (what to deny) are the
  project's. Changing the list needs a change to `k_deny` and the test, not a library upgrade.
- Reverting to libseccomp later is local to `seccomp.c`: the rest of the helper only calls
  `aegis_seccomp_install`.
