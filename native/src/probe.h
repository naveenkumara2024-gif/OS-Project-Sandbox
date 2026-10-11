#ifndef AEGIS_PROBE_H
#define AEGIS_PROBE_H

#define AEGIS_CELL_VERSION "0.0.0"

/*
 * Collects raw syscall-level kernel facts and writes one JSON object plus a newline to stdout.
 * Returns the process exit status: 0 on success, 70 when the output could not be produced.
 */
int aegis_probe_run(void);

#endif
