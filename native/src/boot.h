#ifndef AEGIS_BOOT_H
#define AEGIS_BOOT_H

/*
 * `aegis-cell boot`: reads a launch spec from fd 3, builds the cell, runs the payload as PID 1 of
 * it and reports progress on fd 4. fd 5 is the control pipe: a byte `K` (or EOF) kills the cell.
 *
 * Returns the process exit status: 0 when a payload ran to completion (its own outcome is in the
 * status records), 1 when the cell could not be established (a `layer <name> fail <errno>` record
 * explains why and the payload never ran), 65 for a malformed spec, 70 for an internal error.
 */
int aegis_boot_run(void);

#endif
