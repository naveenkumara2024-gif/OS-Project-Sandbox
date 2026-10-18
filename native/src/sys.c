#define _GNU_SOURCE
#include "sys.h"

#include <sys/syscall.h>
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
#define AEGIS_NR_PIDFD_SEND_SIGNAL 424
#define AEGIS_NR_OPENAT2 437
#define AEGIS_NR_LANDLOCK_CREATE_RULESET 444
#define AEGIS_NR_LANDLOCK_ADD_RULE 445
#define AEGIS_NR_LANDLOCK_RESTRICT_SELF 446
#else
#error "unsupported architecture: add the syscall numbers for it in native/src/sys.c"
#endif

long aegis_sys_clone3(void *args, size_t size)
{
    return syscall(AEGIS_NR_CLONE3, args, size);
}

long aegis_sys_pidfd_send_signal(int pidfd, int sig, unsigned int flags)
{
    return syscall(AEGIS_NR_PIDFD_SEND_SIGNAL, pidfd, sig, NULL, flags);
}

/* pivot_root has no glibc wrapper; its number differs between architectures, so the system header
 * is used for it. */
long aegis_sys_pivot_root(const char *new_root, const char *put_old)
{
    return syscall(SYS_pivot_root, new_root, put_old);
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

long aegis_sys_landlock_add_rule(int ruleset_fd, int rule_type, const void *attr, uint32_t flags)
{
    return syscall(AEGIS_NR_LANDLOCK_ADD_RULE, ruleset_fd, rule_type, attr, flags);
}

long aegis_sys_landlock_restrict_self(int ruleset_fd, uint32_t flags)
{
    return syscall(AEGIS_NR_LANDLOCK_RESTRICT_SELF, ruleset_fd, flags);
}

/* The capset number differs between architectures, so the system header is used for it. */
long aegis_sys_capset(void *header, const void *data)
{
    return syscall(SYS_capset, header, data);
}
