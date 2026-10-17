#ifndef AEGIS_CAPS_H
#define AEGIS_CAPS_H

#include <stdint.h>

/* The five capability sets of the calling process, as the kernel reports them in
 * /proc/self/status (hex masks). */
typedef struct {
    uint64_t inheritable;
    uint64_t permitted;
    uint64_t effective;
    uint64_t bounding;
    uint64_t ambient;
} aegis_capstate_t;

/* Securebits set by aegis_caps_drop: NOROOT, NO_SETUID_FIXUP, NO_CAP_AMBIENT_RAISE, each locked,
 * plus KEEP_CAPS_LOCKED (KEEP_CAPS itself stays off). */
#define AEGIS_SECUREBITS_WANTED 0xcfU

/* Drops every capability and locks the securebits (prompt section 4.2). Returns 0, or -1 with
 * errno of the call that failed. Needs CAP_SETPCAP, so it must run before the permitted set is
 * emptied; it does that itself, in the right order. */
int aegis_caps_drop(void);

/* Reads the five sets from /proc/self/status. Returns 0, or -1 with errno (EPROTO for a malformed
 * file). */
int aegis_caps_read(aegis_capstate_t *out);

/* Reads the state back and returns 0 only if all five sets are empty and the securebits are
 * exactly the wanted ones. This is what "caps_dropped" means in a receipt. */
int aegis_caps_verify_dropped(void);

#endif
