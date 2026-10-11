#ifndef AEGIS_INIT_H
#define AEGIS_INIT_H

/*
 * `aegis-cell init -- <payload argv...>`: PID 1 of a cell (CLAUDE.md 4). Starts the payload as its
 * child, forwards signals to it, reaps every child (including orphans reparented to PID 1), and
 * reports what happened on descriptor 4.
 *
 * argv points at the payload's argv (everything after "--"). Returns the process exit status:
 * 0 when the payload ran and was reported, 64 when not running as PID 1, 70 on an internal error.
 */
int aegis_init_run(char *const *payload_argv);

#endif
