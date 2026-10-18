#define _GNU_SOURCE
#include "seccomp.h"

#include <errno.h>
#include <linux/audit.h>
#include <linux/sched.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>

/*
 * Deny-list seccomp filter, hand-assembled classic BPF (ADR 0005: no libseccomp). Every rule is a
 * compare followed by a return, so no jump offset ever exceeds the 8-bit field: the layout is
 * linear and each rule costs two instructions.
 */

#if defined(__x86_64__)

#define EPERM_RET (SECCOMP_RET_ERRNO | (uint32_t)EPERM)
#define ENOSYS_RET (SECCOMP_RET_ERRNO | (uint32_t)ENOSYS)

/* Clone flags that create a new namespace. All are in the low 32 bits of clone(2)'s flags. */
#define NS_CLONE_FLAGS                                                                             \
    ((uint32_t)(CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER |      \
                CLONE_NEWPID | CLONE_NEWNET))

#define TIOCSTI_CMD 0x5412U
#define TIOCLINUX_CMD 0x541CU

#define OFF_NR 0U
#define OFF_ARCH 4U
#define OFF_ARG(i) (16U + 8U * (i))

static const int k_deny[] = {
    /* kernel and host control */
    SYS_init_module,
    SYS_finit_module,
    SYS_delete_module,
    SYS_kexec_load,
    SYS_kexec_file_load,
    SYS_reboot,
    SYS_swapon,
    SYS_swapoff,
    SYS_acct,
    SYS_syslog,
    SYS_quotactl,
    SYS_iopl,
    SYS_ioperm,
    /* introspection and escape surface */
    SYS_bpf,
    SYS_perf_event_open,
    SYS_userfaultfd,
    SYS_ptrace,
    SYS_process_vm_readv,
    SYS_process_vm_writev,
    SYS_kcmp,
    SYS_pidfd_getfd,
    /* io_uring */
    SYS_io_uring_setup,
    SYS_io_uring_enter,
    SYS_io_uring_register,
    /* keyring */
    SYS_keyctl,
    SYS_add_key,
    SYS_request_key,
    /* mounts and roots */
    SYS_mount,
    SYS_umount2,
    SYS_pivot_root,
    SYS_chroot,
    SYS_move_mount,
    SYS_open_tree,
    SYS_fsopen,
    SYS_fsconfig,
    SYS_fsmount,
    SYS_fspick,
    SYS_mount_setattr,
    /* namespaces */
    SYS_setns,
    SYS_unshare,
    /* device nodes and handles */
    SYS_mknod,
    SYS_mknodat,
    SYS_open_by_handle_at,
    SYS_name_to_handle_at,
    SYS_lookup_dcookie,
};

static struct sock_filter *emit(struct sock_filter *p, struct sock_filter *end, uint16_t code,
                                uint8_t jt, uint8_t jf, uint32_t k)
{
    if (p == NULL || p >= end) {
        return NULL;
    }
    p->code = code;
    p->jt = jt;
    p->jf = jf;
    p->k = k;
    return p + 1;
}

#define LD(off) BPF_LD | BPF_W | BPF_ABS, 0, 0, (off)
#define JEQ(k, jt, jf) BPF_JMP | BPF_JEQ | BPF_K, (jt), (jf), (k)
#define JSET(k, jt, jf) BPF_JMP | BPF_JSET | BPF_K, (jt), (jf), (k)
#define RET(k) BPF_RET | BPF_K, 0, 0, (k)

size_t aegis_seccomp_build(struct sock_filter *out, size_t cap)
{
    struct sock_filter *p = out;
    struct sock_filter *end = out + cap;

    /* Architecture first: a 32-bit process on this kernel reaches int 0x80 with AUDIT_ARCH_I386
     * and different syscall numbers, which would otherwise bypass every number below. */
    p = emit(p, end, LD(OFF_ARCH));
    p = emit(p, end, JEQ(AUDIT_ARCH_X86_64, 1, 0));
    p = emit(p, end, RET(SECCOMP_RET_KILL_PROCESS));
    p = emit(p, end, LD(OFF_NR));
    /* x32 syscalls carry bit 30 in the number and share the arch value. */
    p = emit(p, end, JSET(0x40000000U, 0, 1));
    p = emit(p, end, RET(SECCOMP_RET_KILL_PROCESS));

    for (size_t i = 0; i < sizeof k_deny / sizeof *k_deny; i++) {
        p = emit(p, end, JEQ((uint32_t)k_deny[i], 0, 1));
        p = emit(p, end, RET(EPERM_RET));
    }

    /* clone3 passes its flags behind a pointer that BPF cannot read; ENOSYS makes glibc and musl
     * fall back to clone(2), whose flags are visible. */
    p = emit(p, end, JEQ((uint32_t)SYS_clone3, 0, 1));
    p = emit(p, end, RET(ENOSYS_RET));

    /* clone: any namespace-creating flag is refused. */
    p = emit(p, end, JEQ((uint32_t)SYS_clone, 0, 3));
    p = emit(p, end, LD(OFF_ARG(0)));
    p = emit(p, end, JSET(NS_CLONE_FLAGS, 0, 1));
    p = emit(p, end, RET(EPERM_RET));
    /* after the clone block the accumulator holds arg0, so reload the number for what follows */
    p = emit(p, end, LD(OFF_NR));

    /* ioctl: terminal input injection. The request is an unsigned int. */
    p = emit(p, end, JEQ((uint32_t)SYS_ioctl, 0, 5));
    p = emit(p, end, LD(OFF_ARG(1)));
    p = emit(p, end, JEQ(TIOCSTI_CMD, 0, 1));
    p = emit(p, end, RET(EPERM_RET));
    p = emit(p, end, JEQ(TIOCLINUX_CMD, 0, 1));
    p = emit(p, end, RET(EPERM_RET));
    p = emit(p, end, LD(OFF_NR));

    /* personality: only PER_LINUX (0) and the 0xffffffff query are allowed. */
    p = emit(p, end, JEQ((uint32_t)SYS_personality, 0, 4));
    p = emit(p, end, LD(OFF_ARG(0)));
    p = emit(p, end, JEQ(0U, 2, 0));
    p = emit(p, end, JEQ(0xffffffffU, 1, 0));
    p = emit(p, end, RET(EPERM_RET));

    p = emit(p, end, RET(SECCOMP_RET_ALLOW));

    if (p == NULL) {
        errno = E2BIG;
        return 0;
    }
    return (size_t)(p - out);
}

size_t aegis_seccomp_deny_count(void)
{
    return sizeof k_deny / sizeof *k_deny;
}

int aegis_seccomp_deny_nr(size_t i)
{
    return i < sizeof k_deny / sizeof *k_deny ? k_deny[i] : -1;
}

#else /* not x86_64 */

size_t aegis_seccomp_deny_count(void)
{
    return 0;
}

int aegis_seccomp_deny_nr(size_t i)
{
    (void)i;
    return -1;
}

size_t aegis_seccomp_build(struct sock_filter *out, size_t cap)
{
    (void)out;
    (void)cap;
    errno = ENOSYS;
    return 0;
}

#endif

int aegis_seccomp_install(void)
{
    static struct sock_filter prog[AEGIS_SECCOMP_MAX_INSNS];
    size_t n = aegis_seccomp_build(prog, AEGIS_SECCOMP_MAX_INSNS);
    if (n == 0) {
        return -1;
    }
    struct sock_fprog fp;
    fp.len = (unsigned short)n;
    fp.filter = prog;
    return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &fp, 0UL, 0UL);
}

uint32_t aegis_seccomp_eval(const struct sock_filter *prog, size_t n, const struct seccomp_data *d)
{
    uint32_t acc = 0;
    size_t pc = 0;
    /* Forward-only jumps bound the run to n steps. */
    for (size_t steps = 0; steps <= n && pc < n; steps++) {
        const struct sock_filter *f = &prog[pc];
        switch (f->code) {
        case BPF_LD | BPF_W | BPF_ABS: {
            if (f->k > sizeof *d - 4U || (f->k & 3U) != 0U) {
                return SECCOMP_RET_KILL_PROCESS;
            }
            uint32_t v;
            memcpy(&v, (const uint8_t *)d + f->k, sizeof v);
            acc = v;
            pc++;
            break;
        }
        case BPF_JMP | BPF_JEQ | BPF_K:
            pc += 1U + (acc == f->k ? f->jt : f->jf);
            break;
        case BPF_JMP | BPF_JSET | BPF_K:
            pc += 1U + ((acc & f->k) != 0U ? f->jt : f->jf);
            break;
        case BPF_RET | BPF_K:
            return f->k;
        default:
            return SECCOMP_RET_KILL_PROCESS;
        }
    }
    return SECCOMP_RET_KILL_PROCESS;
}
