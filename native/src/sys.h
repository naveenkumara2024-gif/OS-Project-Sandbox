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

/* struct clone_args from <linux/sched.h>, up to CLONE_ARGS_SIZE_VER2 (88 bytes); see clone3(2). */
struct aegis_clone_args {
    uint64_t flags;
    uint64_t pidfd;
    uint64_t child_tid;
    uint64_t parent_tid;
    uint64_t exit_signal;
    uint64_t stack;
    uint64_t stack_size;
    uint64_t tls;
    uint64_t set_tid;
    uint64_t set_tid_size;
    uint64_t cgroup;
};

#define AEGIS_CLONE_PIDFD 0x00001000ULL
#define AEGIS_CLONE_INTO_CGROUP 0x200000000ULL
#define AEGIS_CLONE_NEWNS 0x00020000ULL
#define AEGIS_CLONE_NEWCGROUP 0x02000000ULL
#define AEGIS_CLONE_NEWUTS 0x04000000ULL
#define AEGIS_CLONE_NEWIPC 0x08000000ULL
#define AEGIS_CLONE_NEWUSER 0x10000000ULL
#define AEGIS_CLONE_NEWPID 0x20000000ULL
#define AEGIS_CLONE_NEWNET 0x40000000ULL
#define AEGIS_CLONE_NEWTIME 0x00000080ULL

long aegis_sys_clone3(void *args, size_t size);
long aegis_sys_pidfd_send_signal(int pidfd, int sig, unsigned int flags);
long aegis_sys_pivot_root(const char *new_root, const char *put_old);
long aegis_sys_openat2(int dirfd, const char *path, const struct aegis_open_how *how, size_t size);
long aegis_sys_pidfd_open(int pid, unsigned int flags);
long aegis_sys_landlock_create_ruleset(const void *attr, size_t size, uint32_t flags);
long aegis_sys_landlock_add_rule(int ruleset_fd, int rule_type, const void *attr, uint32_t flags);
long aegis_sys_landlock_restrict_self(int ruleset_fd, uint32_t flags);
/* capset(2) has no glibc wrapper without libcap. `header` and `data` are the kernel's
 * struct __user_cap_header_struct and an array of two struct __user_cap_data_struct (version 3). */
long aegis_sys_capset(void *header, const void *data);

#endif
