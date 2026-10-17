# Stage 4 report: Hardening

- Branch: `stage/4-hardening`, created from `main` at `32f8110` (Stage 3 merged). Nothing pushed or
  merged by Claude.
- Prompt: `docs/prompts/stage-4-hardening.md`, approved 2026-10-17 (explicit "Approved" answer to
  "Do you approve the Stage 4 prompt as written?"; earlier "proceed" messages were not approval),
  SHA-256 `77093c84007016927d43789a20b9fcec7224cf0d80952618fdc570ad4593d8da`, computed over the
  file in draft form. No amendment was needed; two design refinements are recorded as ADR 0005 and
  ADR 0006, and one hypothesis in section 4.2 was refuted (see "Deviations").
- Environment: WSL2 `6.18.33.2-microsoft-standard-WSL2`, Ubuntu 26.04 LTS, Node 22.22.1, GCC
  15.2.0, Clang 21.1.8. Landlock ABI 7.
- **Status: VERIFYING, not done.** Every acceptance criterion below is met and measured, but the
  work is **not committed**: the commit was refused by the tool-permission classifier (no reason
  given) and Claude did not work around it. CLAUDE.md 0.6 item 7 therefore cannot be met yet. The
  last commit on the branch is the prompt commit `4ec41d5`; the whole implementation is in the
  working tree. See "Open questions" item 1.

## What changed

| Area | Files |
| --- | --- |
| Init hardening | `native/src/init.{c,h}`: non-dumpable, `no_new_privs`, capability drop, then fork; the payload child applies Landlock and, last, seccomp |
| Capability drop | `native/src/caps.{c,h}` (securebits, ambient, bounding set, `capset`, read-back from `/proc/self/status`) |
| seccomp | `native/src/seccomp.{c,h}`: hand-assembled classic BPF, reference evaluator; `native/src/test_filter.c` (table test), `native/src/fuzz_filter.c` (libFuzzer) |
| Landlock | `native/src/landlock.{c,h}`: fixed ruleset for the probed ABI (filesystem, TCP, abstract-socket and signal scopes) |
| Wiring | `native/src/{boot,main,spec,sys}.{c,h}` (`REQUIRE_MASK` and test-only `ABLATE_MASK` keys, `init --require/--ablate`, `overlay` enforced in boot, raw wrappers for `capset` and Landlock), `scripts/build-native.mjs`, `scripts/check-native.mjs`, `scripts/gen-fuzz-seeds.mjs`, `native/src/fuzz_spec.c` |
| Manifest and ceiling | `src/policy/{limits,canonical,ceiling,manifest,policy}.ts`, `policy.default.json` (new `ceiling`), `src/gateway/request.ts` (`manifest`, legacy `limits`) |
| Control plane | `src/launch/run-cell.ts` (resolve, clamp, hash, require mask, second receipt check, ablation guard), `src/main.ts` (policy refusal, no silent default), `src/sys/{status,launch-spec}.ts`, `src/probe/{isolation,isolation-probe}.ts` (tier 4), `src/collect/classify.ts` |
| Tests | `tests/unit/{manifest,ceiling}`, extended `{classify,status,isolation,launch-spec,request}`; `tests/integration/hardening.test.ts`; `tests/escape/probe-{02,04,06,12,13,14,20}-*`; `tests/helpers/parse.ts` |
| Docs | `docs/adr/0005-raw-bpf-seccomp-no-libseccomp.md`, `0006-test-only-layer-ablation-mask.md`, ADR 0003 (tier 4), `docs/SETUP-WSL2.md`, this report |

Size: 964 new lines of C (modules, table test, fuzz target), 3795 lines of C under `native/src` in
total, 4732 lines of TypeScript under `src/` (about 400 of them in `src/policy`). No new npm
dependency and no new native library; nothing needed `sudo`.

## How it works (one paragraph)

`aegis-cell boot` builds the cell as before and execs `init` with `--require <mask>`. Init (PID 1)
sets itself non-dumpable, sets `no_new_privs`, and drops every capability (securebits, ambient,
bounding, then `capset`), reading each state back before it reports the layer. Only then does it
fork the payload. The payload child applies the Landlock ruleset (writes only to `/workspace`,
`/tmp`, `/dev/shm`; no TCP; abstract sockets and signals scoped to its own domain) and, last, the
seccomp filter (read back with `PR_GET_SECCOMP`), then calls `execve`. A layer in the require mask
that fails stops the run before the payload executes; an unrequired one is reported and the run
continues. In TypeScript, a request's `manifest` is validated strictly, clamped to the `ceiling` in
the policy file, canonicalised and hashed; the receipt echoes the resolved manifest, its hash, the
policy file's hash and every clamp. The control plane checks the required layers a second time
against the receipt. An unreadable or invalid policy file refuses the run.

## Step 1 spike (before any implementation file)

Run in the scratchpad, outside the repository, against real cells (release helper), with the draft
code and a static driver that applied the layers around real programs. The workspaces it created
were discarded; no cgroup or directory was left behind.

| Hypothesis | Result |
| --- | --- |
| Each layer reads back | **Confirmed.** `CapInh/Prm/Eff/Bnd/Amb` all `0`, `NoNewPrivs: 1`, `Seccomp: 2` with 1 filter, Landlock ABI 7 with fs, net and scope handled |
| glibc `clone3` to `clone` fallback works under the filter | **Confirmed.** Python threads, `subprocess`, `os.fork`, a static `pthread_create` program, a bash pipeline with a background job and `ls` all ran normally |
| A non-dumpable, capability-less init is unreadable | **Confirmed**, with the spike binary standing in for init: `readlink`/`open` of `/proc/<pid>/fd/*`, `mem`, `environ`, `maps` all `EACCES`; `ptrace(ATTACH)` `EPERM`. Control with no layers: all of them allowed, and the attach succeeded. (Directory listing of `/proc/<pid>/fd` is allowed and only names the descriptors.) The real PID 1 is proven in the integration test |
| Exec of an `MZ` file does not start a Windows process (binfmt `P` flag, no `/init` in the cell) | **Confirmed.** `execve` returns `ENOENT`; from a shell it is "not found" |
| Init can still kill and reap | **Confirmed.** A cap-less, outside-the-domain parent killed a SIGTERM-ignoring child with SIGKILL |
| 4.2: a cap-less uid 0 cannot `mount`, `mknod`, `chroot`, `setns`, `unshare` | **Partly refuted.** `mount`, `chroot`, `unshare -m`, `unshare -n` fail; **`unshare -U` succeeds with only the capabilities dropped** (an unprivileged process may create a user namespace and become root in it). The seccomp filter stops it (also measured). The design already relies on seccomp for this, so only the attribution changes |
| Landlock scopes | `kill` to a process outside the domain is `EPERM`, to its own child allowed; TCP `connect` is `EACCES` |

## Results (all measured in this session)

Commands: `npm run check` (typecheck, ESLint `--max-warnings 0`, Prettier `--check`, Vitest);
`node scripts/check-native.mjs` (clang-format, clang-tidy twice, filter table test under ASan and
UBSan); `node scripts/build-native.mjs release debug-asan` with GCC and again with `--cc=clang`;
`node scripts/build-native.mjs fuzz fuzz-filter --cc=clang`; the two fuzz binaries for 300 s each.

| Check | Result |
| --- | --- |
| `npm run check` | green: 47 files, **451 passed, 11 skipped**, three consecutive full runs identical; `npm audit` 0 vulnerabilities; 134 packages in the tree (`npm ls --all --parseable`, root excluded), none added by this stage |
| Integration and escape suites on helpers built with Clang | 28 files, 205 passed, 11 skipped |
| Native builds | `release` static-pie and `debug-asan` (ASan + UBSan), both compilers, `-Wall -Wextra -Wpedantic -Wconversion -Wshadow -Werror` |
| `check-native` | clang-format clean; clang-tidy clean with and without `-DAEGIS_ENABLE_ABLATION=1`; filter table test `ok` (116 instructions, 45 plain deny rules) |
| Launch-spec fuzz (re-run, parser changed) | **96,561,816** executions in 300 s (321k/s), no crash; 10 new corpus files kept |
| Filter fuzz (assembler plus evaluator) | **37,013,735** executions in 300 s (123k/s), no crash |

The 11 skipped tests are build-specific by design, not missing features: 10 need the ablation
build (`debug-asan`) and are skipped on `release`, and 1 asserts that the `release` build rejects
the ablation switch and is skipped on `debug-asan`. Each of the 11 has its other-build counterpart
running.

### Probes 2, 4, 6, 12, 13, 14, 20 (and the earlier ones, re-run unchanged)

All stopped on both helper builds. None succeeded, so there is no finding to escalate. Every probe
ran against the harness's disposable fixture (a fake HOME with decoy secrets under a temp
directory). Controls are in the tests.

| Probe | What ran | Outcome | Control |
| --- | --- | --- | --- |
| 2 secrets | `cat` of the fixture key by `$HOME`, `~`, the absolute fixture path, `/root`, `/home/*`; `env | grep`; the engine itself ran with decoy `AWS_*` and `HOME` | every read failed (`No such file`), `$AWS_*` and `$HOME` empty, no decoy string anywhere in the output | the decoy key is readable by the engine and the decoy variables are set in its environment |
| 4 Windows interop | `cmd.exe /c whoami` by name and by `/mnt/c/Windows/System32` path, `powershell.exe`, exec of a planted `MZ` file | all exit 126/127; no `/mnt`, `/init`, `/run/WSL`; `/proc/sys/fs/binfmt_misc` empty; the host's `whoami` string never appears | `cmd.exe /c whoami` really works from the engine on this machine (interop on), so the probe is meaningful |
| 6 host sockets | `connect` to `/var/run/docker.sock`, `/run/docker.sock`, `/run/WSL/1_interop`, the dbus socket, a socket in the fixture, and an abstract socket, both of the last two listened on by the harness | all six refused; no `/run`, `/var` or `/run/WSL` entries; the harness listeners saw **0** connections | the listeners accept connections from the engine side (1 and 1); with Landlock off, the network namespace alone still keeps the abstract socket unreachable |
| 12 mount, mknod, chroot | `mount -t tmpfs`, `mount --bind`, `mknod /dev/sda b 8 0`, `mknod` in `/tmp`, `chroot /tmp` | all non-zero ("Operation not permitted"); no `/dev/sda` | each layer alone: capability drop alone, seccomp alone **and Landlock alone** (the kernel denies mount calls to any process in a Landlock domain) each refuse the mounts; with all three off `mount -t tmpfs` returns 0 inside the cell's own mount namespace (nothing reaches the host), and `mknod` of a block device still fails (a user namespace can never make one) |
| 13 namespaces | `unshare -U/-m/-n/-p/-r`; `clone` with `NEWUSER/NEWNS/NEWPID/NEWNET`; raw `unshare`; `setns` on the user and mount namespace descriptors; `clone3` | every one `EPERM`; `clone3` returns `ENOSYS` (errno 38) so libc falls back | with seccomp off and capabilities dropped, **`unshare -U` succeeds** and `-m`/`-n` still fail: seccomp is the layer that stops nested user namespaces |
| 14 kernel surface | `bpf` (prog load, map create), `perf_event_open`, `keyctl`, `add_key`, `io_uring_setup`, `ptrace`, `userfaultfd`, `process_vm_readv` | all `-1`/`EPERM` | with seccomp off, `keyctl(GET_KEYRING_ID)` returns a keyring id: the filter, not capabilities, refuses it (`bpf` still fails there because capabilities are gone) |
| 20 ceiling | request `memory_mb: 8192` and `network.allow: ["evil.example"]` | memory granted 2048; the domain removed; both in `clamped` with requested and granted values; network `{mode: none, egress: false}`; the cell's only interface is `lo` and there are 0 routes | with a 256 MB test ceiling, a program that touches 384 MB is **OOM-killed** (`cause: oom`) although 8 GB was asked for, so the kernel enforces the clamped value |

Probes 1, 3, 5, 7 to 11, 15 to 19 are unchanged and still stopped (the suite passes). Three of
their assertions were tightened or changed on purpose, see "Deviations" item 6.

### Hardening proven from inside the cell

The payload reads the layers back itself (`tests/integration/hardening.test.ts`): all five
capability sets `0000000000000000`, `NoNewPrivs: 1`, `Seccomp: 2`, `Uid: 0 0 0 0`. It reads init's
`/proc/1/status` (capabilities `0`, `NoNewPrivs: 1`) but `readlink /proc/1/fd/4`, `/proc/1/mem`,
`/proc/1/environ` and `/proc/1/maps` are `EACCES`, and `ptrace(ATTACH, 1)` is `EPERM`. **The Stage 2
forged-record scenario now fails:** a payload that writes `exited 0` to `/proc/1/fd/4` gets an error,
exits with 3, and the receipt says `exit_code: 3` with `seccomp: true`. Python, `bash`, `ls`, `cat`
run normally under the full stack. With decoy `AWS_*`, `SSH_AUTH_SOCK` and `HOME` in the engine's
environment, the cell's `env` is exactly `MARKER=...` and `PATH=/usr/bin:/bin`. An overlay run
reaches **level 4** (landlock ABI 7 reported); a run requiring `overlay` without a workspace, or
`landlock` when it is unavailable, is refused with the layer named and the payload's marker file
never appears.

### Measured run cost (not a benchmark)

`/usr/bin/true` through `runCell` (plan, cgroup, spec, spawn, build, init, hardening, run,
teardown), 30 runs after 5 warm-up each, sequential, 16 CPUs, nothing else running:

| Build | Case | level | median | p95 | min | max |
| --- | --- | --- | --- | --- | --- | --- |
| release | no workspace | 2 | 13.1 ms | 14.1 ms | 11.6 ms | 14.6 ms |
| release | overlay workspace, 1 inline file | 4 | 13.6 ms | 16.5 ms | 12.8 ms | 21.5 ms |
| debug-asan | no workspace | 2 | 44.0 ms | 46.7 ms | 38.1 ms | 46.9 ms |
| debug-asan | overlay workspace, 1 inline file | 4 | 40.2 ms | 42.2 ms | 37.9 ms | 42.4 ms |

Stage 3 measured 10.6 ms (p95 11.9 ms) for the no-workspace case, so the hardening and the manifest
add about 2.5 ms (about 24 %) on the release build. The two Stage 3 and Stage 4 numbers were taken
in different sessions, so some of the difference may be machine noise; the workspace case is not
comparable (Stage 3 ingested 200 files, this one writes one).

## Deviations from the prompt

1. **raw BPF instead of libseccomp** (the owner's choice, ADR 0005; CLAUDE.md 2 lists libseccomp).
2. **Bounding-set loop uses `PR_CAPBSET_READ`** (stops at `EINVAL`) instead of reading
   `/proc/sys/kernel/cap_last_cap`; the result is the same and needs no procfs.
3. **A general test-only ablation mask** (`ABLATE_MASK`, ADR 0006) replaces the prompt's single
   "Landlock forced unavailable" flag, because the probe table asks to test each layer alone.
   Compiled only into `debug-asan` and the fuzz targets, never `release`; the control plane refuses
   it unless `AEGIS_TEST_UNSAFE=1`. CLAUDE.md 6.5 also asks for a fixture-path argument; it is not
   added because these switches only weaken the cell and run inside the escape harness (Stage 6's
   destructive ablation will add it). The owner should confirm this reading of 6.5.
4. **Hypothesis 4.2 partly refuted**: dropped capabilities do not stop `unshare -U`; seccomp does.
   And Landlock is a third layer that refuses mounts. Neither changes a design decision.
5. **`seccomp ok` is reported after the filter is installed and read back**, not before as step 8
   of section 4.1 reads; a record written before installing would not be a read-back. The write
   still works under the filter.
6. **Existing tests changed on purpose**, because the new layers are stricter: probe 5 also accepts
   `Permission denied` (Landlock refuses TCP `connect` before the missing route is noticed); probe
   17's write to `/usr` is now refused instead of landing on the cell's tmpfs; the run-cell signal
   test now expects the payload's `kill 1` to be refused (`EPERM`, Landlock signal scope), and the
   SIGTERM-forwarding behaviour is kept under test only when Landlock is unavailable (ablation
   build); the workspace test expects level 4. The classifier now names the **last** failed layer
   instead of the first, because a fallback (overlay to copy) and an optional layer now also write
   failure records and are not what stopped the cell.
7. **Request limits are clamped, no longer rejected**, so the old `request.test.ts` cases for
   `wall_ms: 60001` and `output_kb: 1025` became clamp tests; a request value is rejected only
   past a sanity bound (10^12) or if it is not a positive integer.
8. **Required layers**: `overlay` is enforced in boot (no copy fallback), `cgroup_cpu` and
   `cgroup_kill` are checked before launch; the four hardening layers by init; every other layer
   by the receipt check.

## What a payload can still do after this stage

Stated, not hidden (this repeats the prompt's 4.9 with the measured additions):

- It is uid 0 inside the cell with **no capability and no way to gain one**. It can read all of the
  host's `/usr` (read-only), run any binary there, and write freely under `/workspace`, `/tmp` and
  `/dev/shm`. That is why the commit policy exists.
- When Landlock is unavailable (older kernel), it can also write the cell's own root tmpfs (size
  capped, discarded with the cell) and signal init; the run reports `landlock: false`.
- It can use any syscall not on the deny list, including ones a future kernel adds. A program that
  calls `clone3` directly, without the `clone` fallback, fails with `ENOSYS`. `ptrace`, so `strace`
  and debuggers, is not available.
- The seccomp table covers x86_64 only. On another architecture the layer is not claimed and a
  run that requires it is refused.
- Network egress, the broker and the allowlist do not exist before Stage 5: `network.allow` is
  recorded and clamped, and the receipt says `egress: false`.
- The host kernel is shared. There is no defence against kernel vulnerabilities (CLAUDE.md 1.3).

## Known limitations and risks

- **Level semantics.** Tier 3 (`overlay`) comes before tier 4, so a hardened run *without* a
  workspace reports level 2. The individual layers are all in the receipt. See "Open questions".
- The first `fsop` fuzz target, the `changes.json` strict schema, the positional differ and the
  `RLIMIT_FSIZE` question (Stage 3 leftovers) are untouched, as decided.
- `landlock.c` needs headers that know ABI 6; an older header fails the build rather than dropping
  a right silently. Documented in `docs/SETUP-WSL2.md`.
- Existing tests that assert "every non-workspace layer is true" now include `landlock`, so they
  fail with a clear message on a kernel without it (they do not pass silently).
- The performance figures above are one run of 30 and one machine.

## Open questions for the owner

1. **The commit was refused** by the permission classifier (no reason was given), although CLAUDE.md
   10 authorises local commits on the stage branch. Please either allow the commit (a Bash
   permission rule for `git add`/`git commit`, or tell me to try again), or commit it yourself.
   Until it is committed the stage cannot be `done`.
2. **Level semantics**: should the isolation level count only the tiers a run attempted (so a
   hardened run with no workspace reports 4), or keep the consecutive-tier rule with a workspace
   required for 3 and 4? Changing it is a one-line change in `src/probe/isolation.ts` plus ADR 0003.
3. **CLAUDE.md 6.5 and the ablation mask**: is a control-plane `AEGIS_TEST_UNSAFE=1` guard without a
   fixture-path argument acceptable for these non-destructive switches (deviation 3)?
4. **Landlock optional by default** is as decided; should the default `require` list in
   `policy.default.json` ever include `landlock` on this machine, where it works? Today it is not.
5. The stash `owner-wip-before-stage-4` (your `result.ts`, `request.json`, review docx) is
   untouched. Note that `git stash pop` brings back an `err({code, context})` signature change
   that every current caller (including all the new Stage 4 code) does not use.

## Rollback

All work is on `stage/4-hardening` (uncommitted for now). Back out by deleting the branch or
`git checkout -- .` and removing the new files. No cgroup configuration, system file or package was
touched; cell directories and cgroups follow the Stage 2 and 3 cleanup rules (checked: none left).
