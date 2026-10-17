#ifndef AEGIS_LANDLOCK_H
#define AEGIS_LANDLOCK_H

/* What was handled, for the receipt. */
typedef struct {
    int abi;           /* highest ABI the kernel offers, 0 if none */
    int handled_fs;    /* filesystem rights were handled */
    int handled_net;   /* TCP bind/connect were handled (ABI 4+) */
    int handled_scope; /* abstract unix sockets and signals were scoped (ABI 6+) */
} aegis_landlock_info_t;

/* Returns the ABI version (>= 1), or -1 with errno (ENOSYS, EOPNOTSUPP when Landlock is not
 * available or disabled). */
int aegis_landlock_abi(void);

/* Builds the fixed ruleset for the probed ABI and restricts the calling process (prompt section
 * 4.5). no_new_privs must already be set. Returns 0 or -1 with errno. `info` is filled in as far as
 * the call got. */
int aegis_landlock_apply(aegis_landlock_info_t *info);

#endif
