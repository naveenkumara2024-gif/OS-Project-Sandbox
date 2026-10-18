#ifndef AEGIS_SECCOMP_H
#define AEGIS_SECCOMP_H

#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>

/* Upper bound for the assembled program; the kernel's own limit is BPF_MAXINSNS (4096). */
#define AEGIS_SECCOMP_MAX_INSNS 512U

/* Assembles the deny-list filter (prompt section 4.4) into out[0..cap). Returns the instruction
 * count, or 0 with errno set (E2BIG if cap is too small, ENOSYS on an architecture the table does
 * not cover). */
size_t aegis_seccomp_build(struct sock_filter *out, size_t cap);

/* The plain deny list (syscalls refused with EPERM whatever their arguments), for the table test
 * and the fuzz target. Empty on an architecture the table does not cover. */
size_t aegis_seccomp_deny_count(void);
int aegis_seccomp_deny_nr(size_t i);

/* Builds the filter and installs it for the calling process and its future children. The caller
 * must already have no_new_privs set. Returns 0 or -1 with errno. */
int aegis_seccomp_install(void);

/* Reference evaluator for the subset of classic BPF the assembler emits. Returns the filter's
 * action word. A program that leaves the instruction array, loads outside struct seccomp_data or
 * uses an opcode outside the subset yields SECCOMP_RET_KILL_PROCESS, as the kernel would refuse
 * to load it. Used by the table tests and the fuzz target, never on the enforcement path. */
uint32_t aegis_seccomp_eval(const struct sock_filter *prog, size_t n, const struct seccomp_data *d);

#endif
