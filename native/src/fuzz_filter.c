/*
 * libFuzzer target for the seccomp filter assembler and its reference evaluator (prompt Stage 4
 * section 8). Built only by `node scripts/build-native.mjs fuzz-filter --cc=clang`; never part of
 * the helper. It checks the assembler, not the kernel: the integration tests check the kernel.
 *
 * Input: 4 bytes of buffer capacity, then records of (arch u32, nr u32, args 6 x u64). For every
 * record the evaluator must stay in bounds (ASan) and obey the table:
 *   - not x86_64, or the x32 bit set          -> KILL_PROCESS
 *   - a plain deny-list syscall               -> ERRNO(EPERM)
 *   - clone with a namespace flag             -> ERRNO(EPERM)
 *   - clone3                                  -> ERRNO(ENOSYS)
 *   - ioctl TIOCSTI / TIOCLINUX (low 32 bits) -> ERRNO(EPERM)
 *   - anything else                           -> ALLOW, except the personality rule
 * and nothing else may ever be returned.
 */
#include "seccomp.h"

#include <errno.h>
#include <linux/audit.h>
#include <linux/sched.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>

#if defined(__x86_64__)

#define EPERM_RET (SECCOMP_RET_ERRNO | (uint32_t)EPERM)
#define ENOSYS_RET (SECCOMP_RET_ERRNO | (uint32_t)ENOSYS)
#define NS_FLAGS                                                                                   \
    ((uint32_t)(CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER |      \
                CLONE_NEWPID | CLONE_NEWNET))

static void must(int cond)
{
    if (!cond) {
        abort();
    }
}

static int is_plain_deny(int nr)
{
    for (size_t i = 0; i < aegis_seccomp_deny_count(); i++) {
        if (aegis_seccomp_deny_nr(i) == nr) {
            return 1;
        }
    }
    return 0;
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    static struct sock_filter prog[AEGIS_SECCOMP_MAX_INSNS];
    static size_t n;
    if (n == 0) {
        n = aegis_seccomp_build(prog, AEGIS_SECCOMP_MAX_INSNS);
        must(n > 0 && n <= AEGIS_SECCOMP_MAX_INSNS);
    }
    if (size < 4U) {
        return 0;
    }
    /* A capacity smaller than the program must fail cleanly and write nothing past it. */
    uint32_t cap32;
    memcpy(&cap32, data, sizeof cap32);
    size_t cap = cap32 % (n + 8U);
    struct sock_filter *tmp = malloc((cap + 1U) * sizeof *tmp);
    must(tmp != NULL);
    size_t built = aegis_seccomp_build(tmp, cap);
    must(built == 0 || (built == n && built <= cap));
    free(tmp);

    const size_t rec = 4U + 4U + 6U * 8U;
    for (size_t off = 4U; size - off >= rec; off += rec) {
        struct seccomp_data d;
        memset(&d, 0, sizeof d);
        memcpy(&d.arch, data + off, 4U);
        memcpy(&d.nr, data + off + 4U, 4U);
        memcpy(d.args, data + off + 8U, sizeof d.args);

        uint32_t r = aegis_seccomp_eval(prog, n, &d);
        must(r == SECCOMP_RET_ALLOW || r == EPERM_RET || r == ENOSYS_RET ||
             r == SECCOMP_RET_KILL_PROCESS);

        if (d.arch != AUDIT_ARCH_X86_64 || (d.nr & 0x40000000) != 0) {
            must(r == SECCOMP_RET_KILL_PROCESS);
            continue;
        }
        must(r != SECCOMP_RET_KILL_PROCESS);
        if (is_plain_deny(d.nr)) {
            must(r == EPERM_RET);
        } else if (d.nr == SYS_clone3) {
            must(r == ENOSYS_RET);
        } else if (d.nr == SYS_clone) {
            must((r == EPERM_RET) == (((uint32_t)d.args[0] & NS_FLAGS) != 0U));
        } else if (d.nr == SYS_ioctl) {
            uint32_t cmd = (uint32_t)d.args[1];
            must((r == EPERM_RET) == (cmd == 0x5412U || cmd == 0x541CU));
        } else if (d.nr == SYS_personality) {
            uint32_t p = (uint32_t)d.args[0];
            must((r == SECCOMP_RET_ALLOW) == (p == 0U || p == 0xffffffffU));
        } else {
            must(r == SECCOMP_RET_ALLOW);
        }
    }
    return 0;
}

#else

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    (void)data;
    (void)size;
    return 0;
}

#endif
