#ifndef AEGIS_FWD_H
#define AEGIS_FWD_H

/* The egress forwarder's fixed addresses (prompt Stage 5 section 4.7). The payload sees only an
 * HTTP proxy at 127.0.0.1:3128; the bound socket is the broker's, on the host. */
#define AEGIS_FWD_PORT 3128
#define AEGIS_FWD_MAX_CONN 16
#define AEGIS_BROKER_SOCK_IN_CELL "/.aegis-broker.sock"

/*
 * Runs in a child of init and never returns. Closes every descriptor except `ready_fd`, points
 * stdio at /dev/null, applies its own Landlock domain (read-only filesystem, may bind TCP port
 * 3128 and nothing else) and the seccomp filter, listens on 127.0.0.1:3128, then writes one byte
 * to `ready_fd`: 'R' once it is listening, or 'F' followed by an errno byte if it could not be set
 * up. It then relays each accepted connection to the broker socket, byte for byte, at most
 * AEGIS_FWD_MAX_CONN at a time. It parses nothing, so it has no input parser to fuzz.
 */
void aegis_fwd_run(int ready_fd) __attribute__((noreturn));

#endif
