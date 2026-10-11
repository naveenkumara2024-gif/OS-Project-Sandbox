#define _GNU_SOURCE
#include "sys.h"

#include <unistd.h>

/*
 * Syscall numbers. These calls sit in the unified numbering that starts at 424 and is shared by
 * x86-64 and arm64 (the only architectures this project targets). Using our own constants avoids a
 * dependency on <sys/syscall.h> being recent enough. The probe reports what the running kernel
 * actually answers, so these numbers are exercised, not assumed.
 */
#if defined(__x86_64__) || defined(__aarch64__)
#define AEGIS_NR_PIDFD_OPEN 434
#define AEGIS_NR_CLONE3 435
#define AEGIS_NR_OPENAT2 437
#define AEGIS_NR_LANDLOCK_CREATE_RULESET 444
#else
#error "unsupported architecture: add the syscall numbers for it in native/src/sys.c"
#endif

long aegis_sys_clone3(void *args, size_t size)
{
    return syscall(AEGIS_NR_CLONE3, args, size);
}

long aegis_sys_openat2(int dirfd, const char *path, const struct aegis_open_how *how, size_t size)
{
    return syscall(AEGIS_NR_OPENAT2, dirfd, path, how, size);
}

long aegis_sys_pidfd_open(int pid, unsigned int flags)
{
    return syscall(AEGIS_NR_PIDFD_OPEN, pid, flags);
}

long aegis_sys_landlock_create_ruleset(const void *attr, size_t size, uint32_t flags)
{
    return syscall(AEGIS_NR_LANDLOCK_CREATE_RULESET, attr, size, flags);
}
