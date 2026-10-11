#ifndef AEGIS_SYS_H
#define AEGIS_SYS_H

#include <stddef.h>
#include <stdint.h>

/*
 * Typed wrappers over syscall(2) for kernel interfaces glibc may not expose. sys.c is the only
 * translation unit allowed to call syscall() (CLAUDE.md 2.2).
 *
 * Every wrapper keeps raw syscall semantics: a negative return value means failure and errno holds
 * the reason. Callers must read errno immediately.
 */

/* Mirrors struct open_how from <linux/openat2.h>; see openat2(2). Declared locally so the build
 * does not depend on the kernel headers being recent enough. */
struct aegis_open_how {
    uint64_t flags;
    uint64_t mode;
    uint64_t resolve;
};

/* openat2(2) RESOLVE_BENEATH. */
#define AEGIS_RESOLVE_BENEATH 0x08ULL

/* landlock_create_ruleset(2) LANDLOCK_CREATE_RULESET_VERSION, which is 1 << 0. */
#define AEGIS_LANDLOCK_CREATE_RULESET_VERSION 1U

long aegis_sys_clone3(void *args, size_t size);
long aegis_sys_openat2(int dirfd, const char *path, const struct aegis_open_how *how, size_t size);
long aegis_sys_pidfd_open(int pid, unsigned int flags);
long aegis_sys_landlock_create_ruleset(const void *attr, size_t size, uint32_t flags);

#endif
