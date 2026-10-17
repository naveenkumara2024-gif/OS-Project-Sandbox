# Using AegisEngine from an AI harness

This is the Stage 5 guide: the local gateway, the MCP server, the Claude Code hook and the egress
broker. Setup of WSL2 itself is in `docs/SETUP-WSL2.md`; read its sections 8 to 10 first.

## 1. What you get

| Piece | Command | For |
| --- | --- | --- |
| MCP server | `aegis mcp` (stdio) | Claude Code and other MCP harnesses. Tools `run`, `status`, `diff`, `commit`, `discard`; in Claude Code they appear as `mcp__aegis__run` and so on. |
| Local gateway | `aegis serve` | Your own agent code: HTTP/1.1 over `$XDG_RUNTIME_DIR/aegis/gateway.sock` (mode 0600, no TCP). |
| One-shot CLI | `aegis run`, `diff`, `commit`, `discard` | You, in a terminal. |
| Hook | `dist/hooks/redirect-bash.js` | Steering the model to `mcp__aegis__run` instead of the host shell. |

All of them are the same engine. A **session** is a workspace that survives across runs: the first
`run` that has `files` or `workspace.source` creates one and returns its `session` id; pass that id
to later runs to keep working on the same files. Nothing reaches your real project until `commit`.

## 2. One-time setup

```bash
npm ci --ignore-scripts && npm run build && npm run build:native        # in WSL2, on ext4
mkdir -p ~/.config/aegis && cp policy.default.json ~/.config/aegis/policy.json
$EDITOR ~/.config/aegis/policy.json      # set ingest_roots / commit_roots to your projects
```

The policy file is yours. Keep it outside every project the agent works in: the engine reads it, and
the ceiling in it is what stops a model from asking for more memory, more time or more network than
you allow. An invalid or missing file refuses every run (there is no fallback).

### Claude Code

1. Copy `examples/mcp.json` to `.mcp.json` in your project and replace `/ABSOLUTE/PATH/TO` with the
   path of this repository. The server runs inside `systemd-run --user --scope` because the engine
   must be in a delegated cgroup to place cells (ADR 0003). If it is not, every run is refused with
   a message saying so.
2. Merge `examples/claude-settings.json` into your Claude Code settings: `run`, `status`, `diff` and
   `discard` are allowed; **`commit` is under `ask`**, so you see a prompt before anything is written.
   It also wires the Bash hook.
3. Put the repository (or at least `dist/`) somewhere the agent cannot write. The hook and the server
   are what keep the agent on the safe path, so an agent that can edit them can remove them.
4. Restart Claude Code and approve the project's MCP server when it asks.

## 3. A session, as the model sees it

1. `run` with `files` (or `workspace.source`) and a `command` whose first element is an absolute
   path. The result is a receipt, not an error, even for a failing program: `exit_code`,
   `stdout`/`stderr` (first 64 KiB each), `termination.cause`, `usage`, the isolation `layers` and
   `level`, the resolved `manifest` and its hash, anything `clamped`, and `changes`.
2. Repair and `run` again with the same `session`. Added `files` go into the session; at most one run
   at a time per session.
3. `diff` returns every change with its size, SHA-256 and a patch for small text files, and
   `changes_sha256`.
4. `commit` with the `paths` to apply and the `expected_changes_sha256` from the diff you reviewed.
   If the session has changed since, nothing is written and the new diff comes back. Git hooks,
   symlinks, devices, set-uid files and anything outside the project are refused; deletions are
   reported and not applied.

## 4. Brokered network

By default a cell has no network at all. A manifest can ask for a path to named hosts:

```json
{ "manifest": { "network": { "mode": "brokered", "allow": ["pypi.org", "files.pythonhosted.org"] } } }
```

The cell then gets a loopback and an HTTP proxy at `127.0.0.1:3128` (`HTTP_PROXY`, `HTTPS_PROXY`,
`http_proxy`, `https_proxy`). Programs that ignore the proxy variables cannot connect anywhere. The
proxy is a host-side broker that:

- accepts only HTTP `CONNECT host:port`, for a host on the manifest's allowlist **and** in the
  policy's `network_allow` (the model may ask for less, never more; the rest is listed in `clamped`),
  on a port in the policy's `network_ports` (default 443);
- resolves the name itself and refuses it if **any** answer is private, loopback, link-local,
  carrier-grade NAT, a documentation range, an IPv4 address hidden in an IPv6 form, or on this
  machine's own networks (including the Windows host under WSL2), then connects to the address it
  checked;
- limits each cell to 16 tunnels, 60 s idle, 10 minutes, 64 MiB each way;
- records every attempt, allowed or denied, in the receipt (`network.audit`, up to 256 entries) and in
  `~/.local/state/aegis/audit.jsonl` (mode 0600, rotated once at 10 MiB). Payload bytes are never
  logged.

With the default policy `network_allow` is empty, so a brokered request is resolved to an air-gapped
cell and the receipt says so. Add hosts to your policy to use it.

**What it cannot do.** The broker sees hostnames and ports, not encrypted contents. A program can send
any data to an allowlisted host, so a broad allowlist (a code host, a paste site) is a way out for
data. Keep it to the few hosts a task needs, prefer read-only mirrors, and treat the allowlist as your
decision, not the model's.

## 5. The gateway

```bash
systemd-run --user --scope --quiet --collect -- node dist/main.js serve &
curl --unix-socket "$XDG_RUNTIME_DIR/aegis/gateway.sock" http://aegis/v1/status
curl --unix-socket "$XDG_RUNTIME_DIR/aegis/gateway.sock" -H 'content-type: application/json' \
  -d '{"command":["/usr/bin/echo","hi"]}' http://aegis/v1/runs        # -> {"run":"r-...","session":null}
curl --unix-socket "$XDG_RUNTIME_DIR/aegis/gateway.sock" http://aegis/v1/runs/r-.../events   # NDJSON
```

Routes: `GET /v1/status`, `POST /v1/runs`, `GET /v1/runs/{id}`, `GET /v1/runs/{id}/events` (one JSON
event per line: `queued`, `started`, `stdout`, `stderr`, `limit_warning`, then `receipt` or
`failed`), `POST /v1/runs/{id}/cancel`, `GET /v1/sessions/{id}/diff`,
`POST /v1/sessions/{id}/commit` (`paths`, `expected_changes_sha256`), `DELETE /v1/sessions/{id}`.
Errors are `{"error":{"code","detail"}}` with a code from a fixed list; the detail never repeats what
you sent. Output events are bounded: a slow reader may lose chunks (the next event says how many bytes)
but always gets the receipt, which has the full output.

## 6. What this does and does not protect

- **Protected:** the real project and the rest of your machine from the *programs the model runs*:
  the cell has a private root, no network (or the broker), no capabilities, a syscall filter, a
  filesystem sandbox and resource limits, and what a program changes is a diff you review.
- **Not protected:** the harness itself. The human gate for `commit` is your harness's permission
  prompt plus the diff hash; an agent that also has an unrestricted shell as your user can already edit
  the project directly, and nothing here stops that. The hook is a text heuristic that fails open and
  is easy to get around; it makes the safe path the easy one and nothing more.
- The gateway authenticates by file permissions only (a private directory and a 0600 socket); Node
  cannot read the peer's credentials. That is adequate on a single-user machine.
- The host kernel is shared; there is no defence against kernel vulnerabilities (CLAUDE.md 1.3).

## 7. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `isolation_unavailable (cgroup_placement)` | The engine is not inside a delegated cgroup. Start it with `systemd-run --user --scope ...` (the example `.mcp.json` does). |
| `isolation_unavailable (policy)` or "policy unavailable" | No valid policy file. See section 2; a Stage 4 policy lacks the Stage 5 ceiling keys. |
| `busy` | Another run is in the session, or all cells are in use and the wait ran out (`max_cells`, `memory_budget_mb`). |
| `stale_diff` | The session changed after you reviewed it. Read the returned diff and commit again with its hash. |
| The server shows as failed in Claude Code | Run the command from `.mcp.json` in a terminal; the reason is on stderr (stdout carries only protocol messages). |
