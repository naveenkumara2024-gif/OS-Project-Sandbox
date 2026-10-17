/*
 * Table test for the seccomp deny-list filter (prompt Stage 4 section 8). It assembles the real
 * program with aegis_seccomp_build and runs it through the reference evaluator, so it proves what
 * the assembled instructions decide, not what the source table says. It does not talk to the
 * kernel; the integration tests do that. Built and run by scripts/check-native.mjs.
 */
#include "seccomp.h"

#include <errno.h>
#include <linux/audit.h>
#include <linux/sched.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>

#if !defined(__x86_64__)

int main(void)
{
    puts("test_filter: skipped (the filter table covers x86_64 only)");
    return 0;
}

#else

#define EPERM_RET (SECCOMP_RET_ERRNO | (uint32_t)EPERM)
#define ENOSYS_RET (SECCOMP_RET_ERRNO | (uint32_t)ENOSYS)

static struct sock_filter g_prog[AEGIS_SECCOMP_MAX_INSNS];
static size_t g_n;
static int g_failures;

static uint32_t run(uint32_t arch, int nr, uint64_t a0, uint64_t a1)
{
    struct seccomp_data d;
    memset(&d, 0, sizeof d);
    d.arch = arch;
    d.nr = nr;
    d.args[0] = a0;
    d.args[1] = a1;
    return aegis_seccomp_eval(g_prog, g_n, &d);
}

static void expect(const char *what, uint32_t got, uint32_t want)
{
    if (got != want) {
        printf("FAIL %s: got 0x%08x, want 0x%08x\n", what, (unsigned)got, (unsigned)want);
        g_failures++;
    }
}

int main(void)
{
    g_n = aegis_seccomp_build(g_prog, AEGIS_SECCOMP_MAX_INSNS);
    if (g_n == 0 || g_n > AEGIS_SECCOMP_MAX_INSNS) {
        printf("FAIL build: %zu instructions\n", g_n);
        return 1;
    }
    printf("filter: %zu instructions, %zu plain deny rules\n", g_n, aegis_seccomp_deny_count());

    /* Every plain deny-list entry is refused, whatever the arguments. */
    for (size_t i = 0; i < aegis_seccomp_deny_count(); i++) {
        char name[48];
        int nr = aegis_seccomp_deny_nr(i);
        (void)snprintf(name, sizeof name, "deny nr %d", nr);
        expect(name, run(AUDIT_ARCH_X86_64, nr, 0, 0), EPERM_RET);
        expect(name, run(AUDIT_ARCH_X86_64, nr, ~0ULL, ~0ULL), EPERM_RET);
    }

    /* Named checks for the groups in the prompt, so a table edit that drops one is caught here
     * even if the count still looks right. */
    static const struct {
        const char *name;
        int nr;
    } must_deny[] = {
        {"bpf", SYS_bpf},
        {"perf_event_open", SYS_perf_event_open},
        {"keyctl", SYS_keyctl},
        {"add_key", SYS_add_key},
        {"request_key", SYS_request_key},
        {"io_uring_setup", SYS_io_uring_setup},
        {"io_uring_enter", SYS_io_uring_enter},
        {"io_uring_register", SYS_io_uring_register},
        {"ptrace", SYS_ptrace},
        {"process_vm_readv", SYS_process_vm_readv},
        {"mount", SYS_mount},
        {"umount2", SYS_umount2},
        {"pivot_root", SYS_pivot_root},
        {"chroot", SYS_chroot},
        {"setns", SYS_setns},
        {"unshare", SYS_unshare},
        {"mknod", SYS_mknod},
        {"mknodat", SYS_mknodat},
        {"open_by_handle_at", SYS_open_by_handle_at},
        {"reboot", SYS_reboot},
        {"kexec_load", SYS_kexec_load},
        {"init_module", SYS_init_module},
        {"finit_module", SYS_finit_module},
        {"userfaultfd", SYS_userfaultfd},
        {"fsopen", SYS_fsopen},
        {"mount_setattr", SYS_mount_setattr},
        {"iopl", SYS_iopl},
        {"quotactl", SYS_quotactl},
    };
    for (size_t i = 0; i < sizeof must_deny / sizeof *must_deny; i++) {
        expect(must_deny[i].name, run(AUDIT_ARCH_X86_64, must_deny[i].nr, 0, 0), EPERM_RET);
    }

    /* Ordinary programs keep working. */
    static const struct {
        const char *name;
        int nr;
    } must_allow[] = {
        {"read", SYS_read},
        {"write", SYS_write},
        {"openat", SYS_openat},
        {"close", SYS_close},
        {"execve", SYS_execve},
        {"mmap", SYS_mmap},
        {"futex", SYS_futex},
        {"pipe2", SYS_pipe2},
        {"wait4", SYS_wait4},
        {"kill", SYS_kill},
        {"socket", SYS_socket},
        {"prctl", SYS_prctl},
        {"rt_sigaction", SYS_rt_sigaction},
        {"getdents64", SYS_getdents64},
        {"statx", SYS_statx},
        {"memfd_create", SYS_memfd_create},
        {"exit_group", SYS_exit_group},
    };
    for (size_t i = 0; i < sizeof must_allow / sizeof *must_allow; i++) {
        expect(must_allow[i].name, run(AUDIT_ARCH_X86_64, must_allow[i].nr, 0, 0),
               SECCOMP_RET_ALLOW);
    }

    /* clone: allowed, unless a namespace flag is set. */
    expect("clone plain fork", run(AUDIT_ARCH_X86_64, SYS_clone, (uint64_t)SIGCHLD, 0),
           SECCOMP_RET_ALLOW);
    expect("clone thread",
           run(AUDIT_ARCH_X86_64, SYS_clone,
               CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SIGHAND | CLONE_THREAD | CLONE_SYSVSEM |
                   CLONE_SETTLS,
               0),
           SECCOMP_RET_ALLOW);
    static const struct {
        const char *name;
        uint64_t flag;
    } ns_flags[] = {
        {"CLONE_NEWUSER", CLONE_NEWUSER},     {"CLONE_NEWNS", CLONE_NEWNS},
        {"CLONE_NEWPID", CLONE_NEWPID},       {"CLONE_NEWNET", CLONE_NEWNET},
        {"CLONE_NEWUTS", CLONE_NEWUTS},       {"CLONE_NEWIPC", CLONE_NEWIPC},
        {"CLONE_NEWCGROUP", CLONE_NEWCGROUP},
    };
    for (size_t i = 0; i < sizeof ns_flags / sizeof *ns_flags; i++) {
        expect(ns_flags[i].name, run(AUDIT_ARCH_X86_64, SYS_clone, ns_flags[i].flag, 0), EPERM_RET);
        expect(ns_flags[i].name, run(AUDIT_ARCH_X86_64, SYS_clone, ns_flags[i].flag | CLONE_VM, 0),
               EPERM_RET);
    }
    /* clone3 cannot be inspected, so it is made to fail the way an old kernel would. */
    expect("clone3", run(AUDIT_ARCH_X86_64, SYS_clone3, 0, 0), ENOSYS_RET);

    /* ioctl: terminal input injection only. */
    expect("ioctl TCGETS", run(AUDIT_ARCH_X86_64, SYS_ioctl, 0, 0x5401), SECCOMP_RET_ALLOW);
    expect("ioctl FIONREAD", run(AUDIT_ARCH_X86_64, SYS_ioctl, 0, 0x541B), SECCOMP_RET_ALLOW);
    expect("ioctl TIOCSTI", run(AUDIT_ARCH_X86_64, SYS_ioctl, 0, 0x5412), EPERM_RET);
    expect("ioctl TIOCLINUX", run(AUDIT_ARCH_X86_64, SYS_ioctl, 0, 0x541C), EPERM_RET);
    /* The kernel takes the request as an unsigned int: the upper half is ignored, so a request
     * with garbage there is still TIOCSTI and must still be refused. */
    expect("ioctl TIOCSTI high bits", run(AUDIT_ARCH_X86_64, SYS_ioctl, 0, 0xdead00005412ULL),
           EPERM_RET);

    /* personality: PER_LINUX and the query only. */
    expect("personality 0", run(AUDIT_ARCH_X86_64, SYS_personality, 0, 0), SECCOMP_RET_ALLOW);
    expect("personality query", run(AUDIT_ARCH_X86_64, SYS_personality, 0xffffffffU, 0),
           SECCOMP_RET_ALLOW);
    expect("personality READ_IMPLIES_EXEC", run(AUDIT_ARCH_X86_64, SYS_personality, 0x0400000, 0),
           EPERM_RET);
    expect("personality ADDR_NO_RANDOMIZE", run(AUDIT_ARCH_X86_64, SYS_personality, 0x0040000, 0),
           EPERM_RET);

    /* Architecture: anything but x86_64, and the x32 syscall space, kills the process. */
    expect("arch i386 read", run(AUDIT_ARCH_I386, SYS_read, 0, 0), SECCOMP_RET_KILL_PROCESS);
    expect("arch i386 deny nr", run(AUDIT_ARCH_I386, SYS_mount, 0, 0), SECCOMP_RET_KILL_PROCESS);
    expect("arch aarch64", run(AUDIT_ARCH_AARCH64, SYS_read, 0, 0), SECCOMP_RET_KILL_PROCESS);
    expect("x32 read", run(AUDIT_ARCH_X86_64, SYS_read | 0x40000000, 0, 0),
           SECCOMP_RET_KILL_PROCESS);
    expect("x32 mount", run(AUDIT_ARCH_X86_64, SYS_mount | 0x40000000, 0, 0),
           SECCOMP_RET_KILL_PROCESS);

    /* Assembly bounds: a buffer that is too small is refused, never overrun. */
    struct sock_filter small[4];
    errno = 0;
    expect("build into 4 slots", (uint32_t)aegis_seccomp_build(small, 4), 0);
    expect("build into 4 slots errno", (uint32_t)errno, (uint32_t)E2BIG);
    errno = 0;
    expect("build into 0 slots", (uint32_t)aegis_seccomp_build(small, 0), 0);

    /* The evaluator itself is strict: it does not run off the end of a program. */
    struct sock_filter bad[1] = {{BPF_LD | BPF_W | BPF_ABS, 0, 0, 0}};
    struct seccomp_data d;
    memset(&d, 0, sizeof d);
    expect("program without a return", aegis_seccomp_eval(bad, 1, &d), SECCOMP_RET_KILL_PROCESS);
    struct sock_filter oob[2] = {{BPF_LD | BPF_W | BPF_ABS, 0, 0, 64}, {BPF_RET | BPF_K, 0, 0, 0}};
    expect("load past seccomp_data", aegis_seccomp_eval(oob, 2, &d), SECCOMP_RET_KILL_PROCESS);

    if (g_failures != 0) {
        printf("test_filter: %d failure(s)\n", g_failures);
        return 1;
    }
    puts("test_filter: ok");
    return 0;
}

#endif
