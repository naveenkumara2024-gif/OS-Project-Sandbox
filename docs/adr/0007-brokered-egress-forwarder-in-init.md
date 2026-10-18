# ADR 0007: Brokered egress: the forwarder is a child of init, and Landlock pins the ports

- Status: accepted (design consequence of the Stage 5 prompt section 4.7)
- Date: 2026-10-17
- Refines: Stage 5 prompt 4.7, which names the forwarder "a mode of the static helper, `aegis-cell fwd`"

## Context

A brokered cell has no network interface. The only way out is an HTTP proxy at `127.0.0.1:3128`
that relays to the host-side broker over a Unix socket bound into the cell. Node never runs in a
cell and `socat` is not installed, so the relay is native. The questions were where it runs and how
to stop the payload from using the loopback for anything else.

The Stage 5 spike measured, in a throwaway user and network namespace: loopback can be brought up
by the cell's root and read back; a Landlock domain can allow TCP connect to exactly one port and
deny all others (`EACCES`); a second domain can allow bind to exactly one port; a bind-mounted Unix
socket is usable across a mount namespace.

## Decision

- `boot` binds the broker's socket at `/.aegis-broker.sock` (read-only, nosuid, nodev) and brings `lo`
  up, reading the flags back, before it execs `init`. Both are reported as layers (`loopback`) only
  after being observed. They happen only when the launch spec carries `BROKER_SOCKET`.
- `init` starts the forwarder **by forking itself** rather than exec'ing a `fwd` subcommand. The child
  closes every descriptor except its ready pipe (the status descriptor in particular), points stdio
  at `/dev/null`, applies its own Landlock domain (read and execute only; may bind TCP 3128, connect
  nowhere) and the same seccomp filter as the payload, and only then listens. It reports `listening`
  through the pipe; `init` writes `layer broker ok` after reading that, and a forwarder that cannot
  start stops the run before the payload executes. The forwarder forks one child per connection (at
  most 16), each a byte relay between the TCP socket and the Unix socket. It parses nothing, so it has
  no input parser to fuzz; the broker validates every request.
- The payload's Landlock ruleset gains one rule in a brokered cell: TCP connect to port 3128. Every
  other connect and every bind stays denied, so a program that ignores the proxy variables fails
  closed. On a kernel whose Landlock ABI is below 4 there are no network rules; the cell still has no
  route out, but loopback ports are then reachable by the payload. The receipt reports the ABI.
- The payload can also connect straight to `/.aegis-broker.sock`, bypassing the forwarder. That gives
  it nothing the proxy does not: the broker enforces the same rules on every connection.

## Consequences

- No new subcommand, no new exec, and no second binary: the forwarder shares the image already bound
  into the cell. The cost is that a bug in `fwd.c` would sit in a process that shares init's image
  at fork time; it holds no descriptor, capability or secret init does not also give the payload.
- A fork per connection keeps the relay code short and a stuck peer from blocking others; the limit
  of 16 children bounds it, and the broker's own limits bound the host side.
- `loopback` and `broker` are untiered receipt layers; a manifest may `require` them, and a brokered
  run whose receipt lacks either is refused by the control plane's second check.
