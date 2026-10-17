#ifndef AEGIS_INIT_H
#define AEGIS_INIT_H

#include <stdint.h>

/*
 * `aegis-cell init [--require <mask>] -- <payload argv...>`: PID 1 of a cell (CLAUDE.md 4).
 * Hardens itself (non-dumpable, no_new_privs, no capabilities), starts the payload as its child
 * (which applies Landlock and seccomp just before execve), forwards signals to it, reaps every
 * child (including orphans reparented to PID 1), and reports what happened on descriptor 4.
 */
typedef struct {
    /* enum aegis_require_bit (spec.h): a listed layer that cannot be established stops the run
     * before the payload executes; an unlisted one is reported and the run continues. */
    uint32_t require_mask;
    /* Ablation builds only: enum aegis_require_bit layers to treat as unavailable without trying
     * them (tests). */
    uint32_t ablate_mask;
} aegis_init_opts_t;

/*
 * argv points at the payload's argv (everything after "--"). Returns the process exit status:
 * 0 when the payload ran and was reported, 64 when not running as PID 1, 70 on an internal error
 * or a required layer that could not be established.
 */
int aegis_init_run(char *const *payload_argv, const aegis_init_opts_t *opts);

#endif
