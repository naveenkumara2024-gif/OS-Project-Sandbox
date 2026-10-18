#ifndef AEGIS_LANDLOCK_ABI_H
#define AEGIS_LANDLOCK_ABI_H

#include <linux/landlock.h>
#include <stdint.h>

/*
 * Landlock uapi values that older kernel headers lack. The numbers are kernel ABI and never change;
 * what a given kernel actually supports is decided at run time by landlock_create_ruleset(2)
 * VERSION and the `abi >= N` checks in landlock.c, not by the headers the build machine happens to
 * have. Ubuntu 24.04 (the GitHub runner) ships 6.8 headers, which stop at ABI 4; relying on newer
 * headers made the CI build fail. Each value is only used when the running kernel reports the ABI
 * that introduced it, so a stale header cannot silently drop a right on a new kernel.
 *
 * Values are from include/uapi/linux/landlock.h: ABI 5 (Linux 6.10) added IOCTL_DEV, ABI 6
 * (Linux 6.12) added the scope flags and the `scoped` member of the ruleset attribute.
 */
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif
#ifndef LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET
#define LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#endif
#ifndef LANDLOCK_SCOPE_SIGNAL
#define LANDLOCK_SCOPE_SIGNAL (1ULL << 1)
#endif

/* The ABI 6 layout of struct landlock_ruleset_attr, owned here so the build does not depend on the
 * header declaring `scoped`. The kernel accepts a shorter size from an older ABI and requires the
 * extra bytes to be zero, which they are while `scoped` is left unset. */
struct aegis_landlock_ruleset_attr {
    uint64_t handled_access_fs;
    uint64_t handled_access_net;
    uint64_t scoped;
};

_Static_assert(sizeof(struct aegis_landlock_ruleset_attr) == 24,
               "landlock_ruleset_attr ABI 6 layout is three u64 fields");

#endif
