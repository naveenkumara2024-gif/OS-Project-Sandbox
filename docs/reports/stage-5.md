# Stage 5 report: Integration

- Branch: `stage/5-integration`, created from `stage/4-hardening` at `e7a1543` (Stage 4 is `done` but
  not merged into `main`). Nothing pushed or merged by Claude.
- Prompt: `docs/prompts/stage-5-integration.md`, approved 2026-10-17 (explicit "approved" in answer to
  the presented prompt; the earlier "proceed" messages were not approval), SHA-256
  `8ce6d1b7f6c4aea8c805326b8adf87b022643b1f10d793aec5607362d2c92057`, computed over the file in
  draft form. The open questions in its section 11 were not answered one by one; the recommended
  answers (items 2 to 11) were adopted as the design states them. No amendment was needed.
- Environment: WSL2 `6.18.33.2-microsoft-standard-WSL2`, Ubuntu 26.04 LTS, Node 22.22.1, GCC 15.2.0,
  Clang 21.1.8, Landlock ABI 7.
- **Status: VERIFYING, not done.** Everything in the acceptance gate that can be run from here is
  built, run and measured. The one item left is the **live harness session** (a person using Claude
  Code with the example `.mcp.json` and settings), which only the owner can run; see "Open questions"
  item 1. The automated end-to-end session, which is the gate's first half, passes.

## What changed

| Area | Files |
| --- | --- |
| Engine | `src/engine/{engine,session,session-store,admission,events}.ts`: one service for sessions, admission control, event streams, cancellation, diff and commit |
| Gateway | `src/gateway/{server,limits,errors}.ts`, `src/util/state-dir.ts`: HTTP/1.1 over a 0600 Unix socket in a 0700 directory |
| MCP | `src/gateway/mcp/{jsonrpc,tools,server}.ts`: hand-written stdio server, both protocol eras, five tools |
| Hook and examples | `src/hooks/redirect-bash.ts` (compiled to `dist/hooks/`), `examples/{mcp,claude-settings}.json` |
| Broker (host) | `src/broker/{broker,connect-parser,address-policy,audit}.ts` |
| Broker (cell) | `native/src/fwd.{c,h}`; `boot.c` (socket bind, loopback), `init.c` (forwarder start, payload Landlock plan), `landlock.{c,h}` (port rules), `spec.{c,h}` (`BROKER_SOCKET`), `main.c` |
| Policy and manifest | `src/policy/{ceiling,manifest}.ts` (ceiling keys `network_ports`, `max_cells`, `memory_budget_mb`, `max_sessions`, `session_idle_s`; `network.mode: "brokered"`), `policy.default.json` |
| Run path | `src/launch/run-cell.ts` (external workspaces, events and limit warnings, cancellation, broker lifecycle, proxy environment, receipt `network`), `src/supervise/cell-supervisor.ts`, `src/collect/classify.ts` (`cancelled`) |
| CLI | `src/cli/{context,commands}.ts`, `src/main.ts` (`serve`, `mcp`, `diff`; `run`, `commit`, `discard` on the engine; policy lookup) |
| Support | `src/util/logger.ts`, `src/stage/session-files.ts`, `src/version.ts` |
| Tests | 10 new unit files, `tests/integration/{sessions,gateway,cli,mcp-session,broker}`, `tests/e2e/mcp-client.ts`, `tests/escape/probe-{21,22,23}-*` and broker variants of probes 5 and 20, `tests/global-setup.ts` |
| Docs | `docs/INTEGRATION.md`, `docs/SETUP-WSL2.md`, ADR 0007 (forwarder in init, Landlock ports), ADR 0008 (engine, sessions, policy location), this report |

Size: 4167 lines of C under `native/src` (372 more than Stage 4), 8841 lines of TypeScript under
`src/` (about 4100 more; the prompt estimated about 2400, the engine, gateway, MCP server and broker
each came out near 1000). No new npm dependency (135 lines in `npm ls --all --parseable`, as in
Stage 4; `npm audit` 0 vulnerabilities) and no new native library. Nothing needed `sudo`.

## How it works (one paragraph)

An `Engine` holds a table of sessions (each a workspace directory with a strict `session.json`), an
admission queue (`max_cells`, `memory_budget_mb`) and an event stream per run; the HTTP gateway, the
MCP server and the CLI are adapters over it. A run's output reaches subscribers as bounded events
(`started`, `stdout`, `stderr`, `limit_warning` at 80 %, then the `receipt`), a cancel uses the
timeout kill procedure and ends as `cancelled`, and `commit` applies only the listed paths and only
when the SHA-256 of the change list still matches the one the approver saw. A brokered manifest
gives the cell a loopback, a forwarder child of init and one Landlock rule (connect to port 3128);
the forwarder relays bytes to a host-side broker that accepts only `CONNECT` to allowlisted names on
allowed ports, resolves them itself, refuses any name with a non-public answer, connects to the
address it checked, and audits every attempt into the receipt and a host file.

## Step 1 spike (before any implementation file)

Run in the scratchpad, outside the repository, in throwaway namespaces; nothing it created is left.

| Item | Result |
| --- | --- |
| (a) `systemd-run --user --scope --quiet --collect --same-dir -- node ...` as an MCP-style stdio child | **Confirmed.** stdout carries only the child's output, stdin EOF reaches it, it exits 0 in ~0.7 s (the 0.7 s was my timer), and it runs in a `run-*.scope` under `user@1000.service` |
| (b) Loopback up and read back by a namespace root; Landlock allowing connect to one port and bind to one; a forwarder relaying to a bind-mounted Unix socket | **Confirmed.** payload via 3128 reached the stand-in broker; connects to 3129, 22 and `1.1.1.1:443` and a bind of 3130 or 3128 were `EACCES`; the forwarder could bind 3128 and not 3131; a socket bound into a mount namespace worked |
| (c) A second overlay mount reads files the host wrote into the unmounted upper layer | **Confirmed** for a new file, an overwritten lower file, new files in a new directory and in a merged directory, and a second cell continuing and adding. **Not tested: whiteouts and opaque directories** (see Deviations 5) |
| (d) zod 4 to JSON Schema as an MCP `inputSchema` | **Confirmed** with `io: 'input'` and `unrepresentable: 'any'` (it copes with the transforms) |
| (e) MCP specification pages for `server/discover`, versions and errors | Read; see Deviations 4 for what could and could not be verified |
| (f) Address policy against this machine | The default gateway is `172.22.80.1` (network `172.22.80.0/20`, already inside `172.16/12`); the system resolver answers public addresses for a real name; its nameserver is `10.255.255.254` |

## Results (all measured in this session)

| Check | Result |
| --- | --- |
| `npm run check` (typecheck, ESLint `--max-warnings 0`, Prettier, Vitest), three consecutive runs | green each time: 67 files, **774 passed, 11 skipped** |
| Integration and escape suites on helpers built with Clang (release static-pie and `debug-asan`) | 36 files, 306 passed, 11 skipped |
| Native checks | clang-format clean; clang-tidy clean with and without `-DAEGIS_ENABLE_ABLATION=1`; filter table test `ok` (116 instructions, 45 plain deny rules) |
| Launch-spec fuzz (re-run, the parser gained a key) | **93,713,326** executions in 300 s (311k/s), no crash; 4 new corpus files kept. The seccomp assembler fuzz target was not re-run: `seccomp.c` did not change |
| `npm audit`; packages | 0 vulnerabilities; no package added |

The 11 skipped tests are the same build-specific pairs as in Stage 4 (ablation-only on `release`, a
release-only check on `debug-asan`), not missing features.

### Escape probes 21, 22, 23, and probes 5 and 20 with the broker on

All stopped on both helper builds. None succeeded, so there is no finding to escalate. Controls are
in the tests.

| Probe | What ran | Outcome | Control |
| --- | --- | --- | --- |
| 21 broker SSRF and rebinding | from inside a brokered cell, `CONNECT` to names that resolve to `127.0.0.1`, `169.254.169.254`, `10.x`, `192.168.x`, `100.64.x`, **this machine's real gateway**, a public plus an internal address in either order, `::1`, `fd00::1`, `::ffff:10.0.0.1`, and a NAT64 form; 20 spellings (userinfo, IPv4/short/decimal/hex/octal, bracketed IPv6, percent-escape, path, no port, ports 22, 25, 80, 0, 65536, `0443`); `GET`; a smuggled body | all 12 names `403` and audited `private_address`; every spelling `400`/`403`/`405`; the dialer was **never called** and the decoy server saw **0** connections | the allowlisted public name gets `200`, is dialed at exactly the address that was checked, and the decoy sees 1 |
| 22 gateway abuse | CL.TE smuggling, negative and non-numeric `Content-Length`, an HTTP/2 preface, a bad method, a 30 KB URL, a NUL in the path, absolute-form URL, `../` and `%2e%2e`, binary garbage, 300 pipelined requests, slow headers, a connection flood, and socket directories with modes 770, 750, 755 and 707 | every attack answered 4xx or closed, never a 2xx; the smuggled second request was not served; 0 cells started, 0 sessions; the engine answered `status` afterwards; slow-header clients dropped in under 3 s; the 5th connection refused at the cap; loose directories refused with `EACCES` | `status` works before and after |
| 23 session confusion | another session's file searched by name and by content from inside a cell; 8 forged, off-by-one, upper-case, traversing or wrong-format session ids on the gateway; commit to `/tmp`, `/etc`, a non-root sibling, a symlink inside the root pointing at `/etc`, `..`; a session with a source redirected to another destination; paths through a planted symlink, `..` and an absolute path; a commit against a diff that changed after review; a commit while a cell runs | nothing of the other session visible; every forged id `404`; every destination `EACCES` and the fixture tree byte-identical; redirect `EINVAL`; the only file added anywhere in the fixture was the one approved; stale diff refused, running session `EBUSY` | the real id works (`200`); the allowed root commits; the approved file lands |
| 5 with the broker on | direct connects to `1.1.1.1:443` and the Windows gateway on 53, 445, 135 from a brokered cell; `CONNECT` to a name that resolves to the gateway | all direct connects `EACCES` (Landlock); through the proxy `403`, audited `private_address`; not dialed | probe 5's original assertions unchanged |
| 20 with the broker on | `network.allow` with an unlisted name, brokered | the name removed and listed in `clamped`; `CONNECT` to it `403 not_allowlisted`; the listed name was allowed by policy and dialed once | the clamp list and the audit agree |

Probes 1 to 20 are unchanged and still stopped (the suite passes).

### The end-to-end gate, automated half

`tests/integration/mcp-session.test.ts` launches the real `aegis mcp` process and plays a harness
with a scripted client (`tests/e2e/mcp-client.ts`), over real cells, in **both protocol eras**. The
legacy session: `initialize`, `tools/list` (five tools), `run` a broken program (the failure is data:
`exit_code` non-zero, `SyntaxError` on stderr, level 4), `run` the repaired file in the same session
(`45`), `run` once more producing `report.csv` and planting a symlink and a git hook, `diff` (four
paths, source = the fixture project), a check that the project on disk is **unchanged** (hash
snapshot), `commit` with a stale hash (refused, returns the current diff, still unchanged), `commit`
with the right hash (the two good files committed, the symlink and the hook refused), the project
checked byte for byte, `discard`, and a `diff` of the dead session (`not_found`). Exactly ten replies
for ten requests, every stdout line a JSON-RPC message. The modern session: `server/discover`,
`tools/list` and `tools/call` carrying `_meta`, `resultType: "complete"`, and `-32022` for an
unsupported version. Robustness: garbage, a 1.2 MB line and an unknown method are answered and the
process carries on; cancelling a running call stops the cell (`status` shows 0 running) and sends no
reply for that id; closing stdin mid-call cancels and exits 0; a missing policy exits 65 with the
reason on stderr and nothing on stdout.

### Measured run cost (not a benchmark)

`/usr/bin/true` through `Engine.startRun`, 30 runs after 5 warm-up, sequential, 16 CPUs, nothing else
running:

| Build | Case | median | p95 | min | max |
| --- | --- | --- | --- | --- | --- |
| release | no workspace | 14.2 ms | 16.7 ms | 13.0 ms | 17.4 ms |
| release | session overlay, 1 inline file | 14.8 ms | 17.1 ms | 13.8 ms | 18.5 ms |
| release | brokered (loopback, forwarder, broker) | 14.6 ms | 16.3 ms | 13.7 ms | 22.5 ms |
| debug-asan | no workspace | 42.5 ms | 48.0 ms | 39.9 ms | 48.5 ms |
| debug-asan | session overlay | 46.4 ms | 49.8 ms | 44.8 ms | 50.1 ms |
| debug-asan | brokered | 49.8 ms | 55.5 ms | 47.4 ms | 56.6 ms |

Stage 4 measured 13.1 ms (no workspace, release), through `runCell` directly, in another session; the
engine, events and session layers add about 1 ms to that. A brokered cell costs about 0.4 ms more than
an air-gapped one (it starts a forwarder and a socket) on `release`.

- **Streaming:** a program printing a line every 100 ms: each `stdout` event arrived **50 to 51 ms**
  after it was written (median 51, p95 51 on `release`; 50, 51 on `debug-asan`; n = 10 each). That is
  the 50 ms coalescing window: a lone line after silence waits for it.
- **Gateway:** sequential `GET /v1/status`, a new connection each, 1000 requests: 0.72 ms each,
  1383 per second (`release` run); 0.77 ms, 1293 per second (second run). One client, one machine;
  not a benchmark.

## Deviations from the prompt

1. **The hook is TypeScript** (`src/hooks/redirect-bash.ts`, compiled to `dist/hooks/redirect-bash.js`),
   not `hooks/redirect-bash.mjs`, so it is linted, type-checked and unit-tested like everything else.
   The example settings point at the compiled file.
2. **The forwarder is a forked child of init**, not an `aegis-cell fwd` subcommand (ADR 0007). It has
   the same properties the prompt asked for (own Landlock domain, seccomp, no parser) without an exec.
3. **`started` is emitted when the cell is launched**, not when the payload has started: the supervisor
   only sees the helper's status stream at the end. The receipt's records remain the authority.
4. **MCP versions.** Verified against the specification pages on 2026-10-17: the stdio framing, the
   `2026-07-28` modern era (`server/discover`, per-request `_meta`, `-32022`, `-32602`), and the
   `2025-11-25` legacy handshake. The versions `2025-06-18`, `2025-03-26` and `2024-11-05` in the
   legacy list were **not** each checked (`2024-11-05` appears in the specification's own example;
   the other two I know from memory). `tools/list`, `tools/call` and `ping` are identical in all of
   them as far as I know. `discover` advertises only the modern version; the `-32022` error lists
   both eras. Batches (JSON arrays) are refused as invalid requests.
5. **Whiteouts and opaque directories were not verified**, so later-run `files` that land on a
   whiteout or under one are **refused** (`workspace_files`) instead of being written. The spike
   command for those cases was blocked by a built-in removal guard (it contained `rm` inside an
   `unshare sh -c` script, and was not worked around), so the other cases were run without any
   deletion.
6. **The policy file location changed** (adopted open question 2): `AEGIS_POLICY_FILE`, else
   `~/.config/aegis/policy.json`, else refuse; the repository's `policy.default.json` is a template.
   The strict schema now requires the five Stage 5 ceiling keys, so a Stage 4 policy file is refused.
7. **Request changes:** `id` is optional (a label); `session` is accepted and must be a server id;
   `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and `FTP_PROXY` are reserved environment
   names; `manifest.network.mode` accepts `brokered`.
8. **`aegis commit` no longer needs `--dest`** when the session has a source; `--expect` binds it to a
   diff hash. `aegis diff` is new. Stage 3 workspaces (no `session.json`) cannot be committed through
   the new CLI; their `changes.json` is no longer read or written. This closes the Stage 3 leftover
   about a shape-checked `changes.json`, by removing it.
9. **MCP results clip stdout and stderr to 64 KiB each** and drop per-file patches from a run result
   that would exceed 200 KiB (use `diff`); the cell's own output cap is unchanged.
10. **The gateway enforces the header count itself**, because Node's `maxHeadersCount` truncates
    silently instead of refusing. It also refuses a socket path of 108 bytes or more with a clear error.
11. **`dist/` is built once by a Vitest global setup** instead of by individual test files, because
    parallel files raced on it.
12. **Bugs found and fixed before this report**, each by a test or a measurement: `Engine.close()`
    left an 8 s timer that made every `aegis run` take 8.5 s (now 0.5 s); the over-eager "second check"
    flipped a legitimately timed-out cell into `isolation_unavailable` (found by the Stage 2 race test
    when the manifest check was first added); my first slow-header test failed because the client never
    read the socket (the gateway was correct); the cross-session probe's `grep` matched
    `/proc/*/cmdline` (its own command line); probe 5's inline Python had unescaped `\r\n`. One commit
    (`756b6c9` before the amend) was made while ESLint was failing because a pipe hid its exit status;
    it was amended before anything else was built on it, and every later check writes the exit code
    to a file first.
13. **Jazzer.js was not added** (adopted open question 7); the new parsers (JSON-RPC, the `CONNECT`
    parser, the address policy, the policy file, session files) have fast-check properties, including
    "never throws on arbitrary input".

## What a payload can still do after this stage

Stated, not hidden (this adds to the Stage 4 list):

- In a **brokered** cell it can send any data to any allowlisted host on an allowed port. The broker
  sees hostnames and ports, not encrypted contents. A broad allowlist is a way out for data.
- It can connect to the forwarder's port and, by path, to the broker socket; both reach the same
  broker, which judges every request. On a kernel with Landlock ABI below 4 there are no network
  rules, so it could also use loopback ports inside the cell (there is still no route out).
- It cannot reach another session, the gateway socket (not in the cell), or the host's loopback.
- An agent that holds an unrestricted shell **as the user** is outside everything here: it can edit
  the project, the policy file and this program directly. The human gate for `commit` is the
  harness's permission prompt plus the diff hash; the hook is a heuristic.

## Known limitations and risks

- **The live harness session has not been run** (open question 1).
- The gateway cannot read the peer's credentials; protection is the 0700 directory and 0600 socket.
- The broker connects to the first resolved address only (no fallback to the next); a name whose first
  answer is unreachable fails with `502`.
- The broker's pin is "check, then connect by number"; a name can still change between runs, which is
  the allowlist's job, not the broker's.
- A session's owner liveness uses the process id; a recycled pid keeps a dead engine's session until
  that pid dies (the same property as the Stage 2 cell reaper).
- Two engines at once do not share a session table; a session made by one is usable by the other
  only through the CLI's `adopt` path (diff, commit, discard).
- Events are lossy for a slow reader by design; the receipt is not.
- The MCP `run` call returns only when the run ends (no MCP progress notifications); streaming is a
  gateway feature.
- Deletions in a change list are still reported and not applied (open question 5, recommended answer).
- The hook is word matching: it has false positives (`python3 --version`) and is easy to bypass.
- The level rule from Stage 4 is unchanged (a hardened run without a workspace reports level 2); the
  question was not decided.

## Commits on `stage/5-integration` (base `e7a1543`)

See `git log e7a1543..HEAD`. The last commit holds this report and the state in `docs/STAGES.md`.

## Open questions for the owner

1. **The live harness session.** I could not run Claude Code against this server from here: `claude`
   resolves to a Windows installation under `/mnt/c`, and nothing here reloads an MCP configuration
   into a running session. To run it: follow `docs/INTEGRATION.md` section 2, ask Claude Code to write
   and run a small program in a project under your `ingest_roots`, and send the transcript or a
   screenshot including the `commit` approval prompt. If you would rather close the stage on the
   automated session alone (the prompt's open question 10 allows that), say so and I will mark it
   `done`.
2. **Your policy file.** `~/.config/aegis/policy.json` (192 bytes, 2026-10-12) is now the default
   location and I did not read or change it. The engine refuses to run with it (`isolation_unavailable`,
   layer `policy`, `EINVAL`): it predates the Stage 4 `ceiling` and the Stage 5 keys. Replace it with
   `cp policy.default.json ~/.config/aegis/policy.json` and set `ingest_roots` and `commit_roots`
   (and `network_allow`, if you want brokered network) yourself.
3. **Stage 4 and Stage 5 are not merged** into `main`; `stage/5-integration` is based on the Stage 4
   tip. Merging is yours.
4. **Stdout event latency.** A lone line after silence waits 50 ms. Flushing the first chunk after
   idle at once (and coalescing only the following ones) would make it near zero; I left it because
   the prompt specified the 50 ms window. Say if you want it changed.
5. The Stage 4 question about the isolation level for runs without a workspace is still open.

## Rollback

All work is on `stage/5-integration`. Back out with `git revert` or by deleting the branch. No
cgroup configuration, system file or package was touched. Sessions live under `$TMPDIR` and are
removed by `discard`, expiry or the startup sweep; the gateway socket is under
`$XDG_RUNTIME_DIR/aegis` and is removed on shutdown; `~/.local/state/aegis` (logs and audit) is safe
to delete. Cells and cgroups follow the Stage 2 cleanup rules (checked: none left).
