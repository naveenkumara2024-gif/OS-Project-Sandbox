---
stage: 4
name: hardening
status: approved
created: 2026-10-11
approved_at: 2026-10-17
approved_sha256: 77093c84007016927d43789a20b9fcec7224cf0d80952618fdc570ad4593d8da
---

# Stage 4: Hardening

## 1. Goal

At the end of this stage the payload holds no capability, cannot gain privilege, runs under a seccomp syscall filter and a Landlock filesystem ruleset (when the kernel offers it), and cannot reach init's descriptors or memory. Init itself also runs without capabilities. Every run is governed by a **manifest**: the request's limits, network request, workspace mode and required layers, clamped by a human-owned ceiling policy file, hashed, with the hash, the resolved values and every clamp echoed in the receipt. A run whose manifest requires a layer that is missing is refused, never weakened. Probes 2, 4, 6, 12, 13, 14 and 20 are stopped and proven, contribution 4 (policy-as-data) exists for the first time, and the receipt's isolation level can reach 4.

## 2. Context

- Stages 0 to 3 are done and merged into `main` (`32f8110`). The cell has 8 namespaces, a verified private root, cgroup limits, `aegis-cell init` as PID 1, an overlay workspace with commit and discard, and a receipt at levels 2 and 3.
- Today the payload is uid 0 in its own user namespace with a **full** capability set (`CapEff 0x1ffffffffff`, measured in Stage 1). It can `ptrace` init and read `/proc/1/fd`, which is why init's status records are forgeable (Stage 2 report). Closing that is a main point of this stage.
- Blueprint sections relied on: "Syscall filtering", "Capabilities and no_new_privs", "Landlock", N2 and N4 (receipts and manifests), the probe table.
- **Facts read on the owner's machine (read-only, 2026-10-11 and re-checked 2026-10-17)**, kernel `6.18.33.2-microsoft-standard-WSL2`:
  - `libseccomp-dev` is **not installed**: only the runtime `libseccomp2` 2.6.0 exists, with no `seccomp.h` and no `libseccomp.a`. Linking libseccomp, as CLAUDE.md 2 lists, would need the owner to run `sudo apt install libseccomp-dev`.
  - Kernel UAPI headers `linux/seccomp.h`, `linux/filter.h` and `linux/landlock.h` are present.
  - Landlock ABI 7, `seccomp_mode` 0 and `no_new_privs` 0 for the engine (Stage 0 probe). `/sys/kernel/security/lsm` is absent. `cap_last_cap` is 40. Yama `ptrace_scope` is 1 (a holder of `CAP_SYS_PTRACE` in the namespace bypasses it, which is today's payload).
  - WSL interop is registered in binfmt_misc as `WSLInterop`: magic `4d5a` (`MZ`), interpreter `/init`, flags `P` (no `F`). Without `F` the kernel opens the interpreter path at exec time in the caller's root. The cell has no `/init`, so exec of a PE file inside the cell should fail with `ENOENT`. **Hypothesis**, confirmed in step 1.
- Items marked **hypothesis** are confirmed or refuted by step 1 before the design depends on them.

## 3. In scope / out of scope

In scope:

- **Init hardening**, at init's start, before it forks the payload: `PR_SET_DUMPABLE 0` (the payload cannot read `/proc/1/*` or ptrace init), `no_new_privs`, and the full capability drop. Init needs no capability for its work (signals and `waitpid` inside its own pid namespace, same uid). This closes the Stage 2 forgeable-record limitation.
- **Capability drop**: bounding, inheritable, permitted, effective and ambient sets all empty, securebits `NOROOT`, `NO_SETUID_FIXUP`, `KEEP_CAPS` off and `NO_CAP_AMBIENT_RAISE`, each with its `_LOCKED` bit. Verified by reading `/proc/self/status` back.
- **`no_new_privs`**, verified with `PR_GET_NO_NEW_PRIVS`.
- **Landlock** ruleset (probed ABI), applied by the payload's process just before `execve`: writes confined to `/workspace`, `/tmp`, `/dev/shm`; read and execute on the rest of the private root; TCP bind and connect denied (ABI 4+); abstract Unix sockets and signals scoped to the payload's own domain (ABI 6+). An optional layer by default, reported `true` only when applied.
- **seccomp-bpf filter**, installed last by the payload's process, after Landlock, immediately before `execve`. It covers only the payload's process tree, not init. It has a documented deny list (section 4.4) and an architecture check that fails closed.
- **Environment scrub, verified**: the cell's environment is the explicit spec one, nothing inherited. A test starts the engine with decoy `AWS_*`, `SSH_AUTH_SOCK` and `HOME` and proves none of them appear in the cell.
- **Manifest and ceiling policy** (section 4.6): `manifest` in the request, strict `zod` schema, clamped to a new `ceiling` object in `policy.default.json`, canonical JSON, SHA-256 echoed. The policy file itself moves to a strict `zod` schema and an unreadable or invalid policy file refuses the run instead of falling back to defaults (today's `loadPolicy` silently defaults).
- Escape probes 2, 4, 6, 12, 13, 14, 20 with controls; tests; sanitizer and fuzz runs.

Out of scope (and the stage that owns it):

- Network egress, the broker, loopback bring-up, working domain allowlists: **Stage 5**. The network mode stays `none`. Domains in a manifest are clamped against the ceiling's allowlist (empty by default) and reported. Even an allowed domain gets no network until Stage 5, and the receipt says so.
- Gateway, MCP, sessions: **Stage 5**.
- Layer-disabling ablation flags and the ablation matrix: **Stage 6**. This stage only structures each layer as a separately callable function so Stage 6 can switch them.
- A non-root uid inside the cell: the payload stays uid 0 with no capabilities (Stage 1 decision). Section 11 item 6 asks the owner to confirm this.
- **Stage 3 open items**: the `changes.json` strict schema, the missing `fsop` fuzz target, the positional differ and the `RLIMIT_FSIZE` question. These belong to Stage 3's branch under CLAUDE.md 0.8 and are not touched here. Section 11 item 7 asks the owner how to handle them.

## 4. Design

### 4.1 Where each layer is applied, and in what order

```
boot child (PID 1, after pivot_root)  -- namespace-local caps, as today; mounts, overlay
  -> execve /.aegis-init               -- fresh image, still uid 0 with caps
init (PID 1)
  1. PR_SET_DUMPABLE 0                  (after the execve above, which reset it to 1)
  2. PR_SET_NO_NEW_PRIVS 1, read back
  3. capability drop (4.2), read back   (init now has no capability at all)
  4. report  layer no_new_privs ok, layer caps_dropped ok
  5. fork the payload child
payload child, immediately before execve:
  6. Landlock restrict_self (4.5)       (allowed without caps because no_new_privs is set)
  7. seccomp(SECCOMP_SET_MODE_FILTER)   (last, CLAUDE.md 6.1 item 4)
  8. report  layer landlock ok|fail, layer seccomp ok   (written before 7 takes effect
                                                         on anything; write(2) stays allowed)
  9. execve payload
```

Why this order: `no_new_privs` must be set before seccomp and Landlock can be installed by a process without `CAP_SYS_ADMIN`. The bounding-set drop and the securebits change need `CAP_SETPCAP`, so they run before the permitted set is cleared (4.2). The filter is last so that nothing after it needs a denied syscall. The payload inherits init's empty capability sets and `no_new_privs` through `fork`; `execve` cannot regain anything, because the bounding set is empty and `SECBIT_NOROOT` is locked.

Failure: any step that fails writes `layer <name> fail <errno>` and the payload is never executed (the existing exec-pipe path from Stage 2 reports it). The receipt states the failure. A required layer that failed refuses the run (4.6).

Trust after this stage: the payload no longer holds `CAP_SYS_PTRACE`, init is non-dumpable, and descriptor 4 is close-on-exec before the payload's `execve`. Init's records therefore can no longer be forged by the payload. The report will say this only after the probe in section 8 proves it.

### 4.2 Capability drop (native, `caps.c`)

In this order, each call checked:

1. `prctl(PR_SET_SECUREBITS, NOROOT|NOROOT_LOCKED|NO_SETUID_FIXUP|NO_SETUID_FIXUP_LOCKED|KEEP_CAPS_LOCKED|NO_CAP_AMBIENT_RAISE|NO_CAP_AMBIENT_RAISE_LOCKED)` (needs `CAP_SETPCAP`).
2. `prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL)`.
3. `prctl(PR_CAPBSET_DROP, c)` for every `c` from 0 to `cap_last_cap`, read from `/proc/sys/kernel/cap_last_cap` (40 here). Needs `CAP_SETPCAP`, so it runs before step 4.
4. `capset` with effective, permitted and inheritable all zero (raw `capget`/`capset` through `sys.c`; no libcap).
5. Verify: parse `CapInh`, `CapPrm`, `CapEff`, `CapBnd`, `CapAmb` from `/proc/self/status` into a fixed buffer. The layer `caps_dropped` is `true` only if all five are `0`.

**Hypothesis**: uid 0 in this state cannot `mount`, `mknod`, `chroot`, `setns`, `unshare`, change ownership to an unmapped id or `ptrace` a non-dumpable process. Step 1 tests each one before seccomp is added, so the report can say which layer stops what.

### 4.3 Init non-dumpable

`PR_SET_DUMPABLE 0` makes `/proc/1/*` owned by root and gates `ptrace` and `/proc/1/{fd,mem,environ}` access on `CAP_SYS_PTRACE` in the namespace, which the payload no longer has. The payload's own `execve` resets its own dumpable flag to 1, so its tools (for example `ps` and `/proc/self`) keep working.

### 4.4 seccomp filter (native, `seccomp.c`)

The filter is classic BPF assembled in C from a static table. Unless noted, a matched rule returns `SECCOMP_RET_ERRNO|EPERM`.

| Group | Syscalls |
| --- | --- |
| Architecture | `arch != AUDIT_ARCH_X86_64` → `KILL_PROCESS`; x32 (`nr & 0x40000000`) → `KILL_PROCESS`. The 32-bit `int 0x80` entry reports `AUDIT_ARCH_I386` and is therefore killed |
| Kernel and host control | `init_module`, `finit_module`, `delete_module`, `kexec_load`, `kexec_file_load`, `reboot`, `swapon`, `swapoff`, `acct`, `syslog`, `quotactl`, `iopl`, `ioperm` |
| Introspection and escape surface | `bpf`, `perf_event_open`, `userfaultfd`, `ptrace`, `process_vm_readv`, `process_vm_writev`, `kcmp`, `pidfd_getfd` |
| io_uring | `io_uring_setup`, `io_uring_enter`, `io_uring_register` (a large attack surface that also performs operations seccomp never sees) |
| Keyring | `keyctl`, `add_key`, `request_key` |
| Mounts and roots | `mount`, `umount2`, `pivot_root`, `chroot`, `move_mount`, `open_tree`, `fsopen`, `fsconfig`, `fsmount`, `fspick`, `mount_setattr` |
| Namespaces | `setns`, `unshare`; `clone` with any `CLONE_NEWNS/NEWCGROUP/NEWUTS/NEWIPC/NEWUSER/NEWPID/NEWNET` bit (argument check on `flags`); `clone3` → `ENOSYS`, so glibc falls back to `clone`. `clone3` passes its flags behind a pointer, which BPF cannot read. Docker and systemd use the same `ENOSYS` approach |
| Device nodes and handles | `mknod`, `mknodat`, `open_by_handle_at`, `name_to_handle_at`, `lookup_dcookie` |
| Terminal injection | `ioctl` with request `TIOCSTI` or `TIOCLINUX` (argument check) |
| Other | `personality` with any value other than `PER_LINUX` and `0xffffffff` (query) |

Everything else is allowed.

**Why a deny list rather than an allowlist:** the blueprint chose it, and an allowlist of the whole syscall surface used by arbitrary AI-generated programs would break far more than it protects at this stage. The report will state the cost: a dangerous syscall that a future kernel adds is allowed until someone lists it.

**Hypothesis:** Python 3, `bash`, `dash`, coreutils, a threaded C program and Node-free toolchains (`gcc` output) run unmodified under this list, including glibc's `clone3` → `clone` fallback. Step 1 runs a representative set before the list is frozen, and the report lists anything the filter breaks. Nothing is silently allowed.

### 4.5 Landlock (native, `landlock.c`)

The ruleset is built for the probed ABI (`landlock_create_ruleset(NULL, 0, VERSION)`). Handled rights are every filesystem right that ABI knows (including `REFER` from ABI 2, `TRUNCATE` from ABI 3 and `IOCTL_DEV` from ABI 5), `NET_BIND_TCP` and `NET_CONNECT_TCP` (ABI 4) with no port rules, and `SCOPE_ABSTRACT_UNIX_SOCKET` and `SCOPE_SIGNAL` (ABI 6). Rules come from a **fixed table in C**: the control plane supplies no paths, so there is nothing to validate.

| Beneath | Rights |
| --- | --- |
| `/` | read file, read dir, execute (covers `/usr`, `/etc`, `/proc`, the `/bin` and `/lib` links) |
| `/workspace`, `/tmp`, `/dev/shm` | all filesystem rights, including make-reg, make-dir, remove, refer, truncate |
| `/dev` | read and write file, `IOCTL_DEV` (`/dev/null`, `/dev/tty` and so on) |

`SCOPE_SIGNAL` means the payload cannot signal init, which sits outside its domain. Init still signals the payload, because signalling into a domain from outside is allowed. Below ABI 6 the scopes are skipped, and below ABI 4 the network rights are skipped. The receipt states the ABI used and which right groups were handled. Landlock is **optional by default**: `landlock` is `true` only when `restrict_self` succeeded, and a run that did not require it proceeds without it (section 11 item 3).

### 4.6 Manifest, ceiling, hash (TypeScript, `src/policy/`)

```json
"manifest": {
  "limits":  { "memory_mb": 512, "wall_ms": 10000 },
  "network": { "mode": "none", "allow": [] },
  "workspace": { "mode": "overlay" },
  "require": ["caps_dropped", "no_new_privs", "seccomp"]
}
```

- `limits` are today's request limits moved under the manifest. A request with a top-level `limits` and no `manifest` is still accepted and treated as `manifest.limits`, so existing callers and tests keep working. A request with both is rejected (`EINVAL`). An ambiguous request is refused, never guessed at.
- `network.mode` accepts only `"none"` in this stage. `network.allow` is a list of domain names (hostname syntax, bounded). Each domain not in the ceiling's `network_allow` (empty by default) is removed and listed in `clamped`. The resolved mode stays `none` until Stage 5.
- `require` is a set of layer names from the receipt vocabulary, defaulting to `["caps_dropped", "no_new_privs", "seccomp"]`. `landlock` and `overlay` may be added. The resolved `require` is the union of the request's set and the ceiling's `require_at_least`. A request can add requirements, never remove the ceiling's.
- Ceiling: a new `ceiling` object in `policy.default.json` with a maximum for each limit, `network_allow` and `require_at_least`. Every value reduced to its ceiling is listed in `clamped` as `{ field, requested, granted }`. The model may ask for less, never more (CLAUDE.md 6.4).
- `manifest_sha256` is the SHA-256 of the canonical JSON (keys sorted, no whitespace, integers only, arrays in a defined order) of the **resolved** manifest. `ceiling_sha256` is the SHA-256 of the policy file bytes as read. Together they show which request and which policy governed the run.
- Refusal: after the cell reports, any `require`d layer that is not `true` makes the response `isolation_unavailable` naming that layer, and the payload has not run. Init checks this before forking: the control plane passes the resolved `require` set to the helper as a launch-spec bitmask (one new spec key), so init refuses before `execve` rather than after. TypeScript checks the receipt a second time. Both checks fail closed.
- The policy file is parsed with a strict `zod` schema (`_comment` allowed as a string, every other unknown key rejected, forbidden keys rejected, size cap before parsing). An unreadable or invalid policy file refuses the run with layer `policy`.

### 4.7 Receipt and protocol additions

- `isolation.layers` gains `caps_dropped`, `no_new_privs`, `seccomp` and `landlock`, plus `landlock_abi` (number or null).
- Tier 4 (ADR 0003) is `caps_dropped`, `no_new_privs` and `seccomp`. `landlock` is reported but not tiered, so a kernel without Landlock can still reach level 4, as in the blueprint's example. Tiers 1 to 3 are not renumbered.
- The response carries `manifest` (resolved), `manifest_sha256`, `ceiling_sha256` and `clamped`.
- `src/sys/status.ts` gains the four layer names and the failure-only layer `policy`. The status parser stays strict.
- One new launch-spec key, `REQUIRE_MASK` (u32 bitmask). The spec version stays 1: the parser already rejects unknown keys and the helper and control plane ship together. The spec fuzz target is re-run because the parser changed.

### 4.8 The five contributions

1. Diff-then-commit: unchanged. The commit path also benefits, because the payload can no longer create device nodes and set-uid bits do not survive `no_new_privs` exec.
2. Fail-closed receipts: every new layer is `true` only after being read back, and a required but missing layer refuses the run in init before `execve` and again in the control plane.
3. Termination causes: a seccomp `EPERM` is an ordinary syscall failure. `KILL_PROCESS` (wrong architecture only) appears as `signal:SIGSYS`, and the classifier gives it a hint naming seccomp.
4. **Manifests as policy-as-data are implemented here** (4.6).
5. Escape corpus: seven more probes.

### 4.9 What a payload can still do after this stage (stated, not hidden)

- Read all of the host's `/usr` (read-only), run any binary there, and write freely under `/workspace`, `/tmp` and `/dev/shm`. This is why the commit policy exists.
- Write to the cell's own root tmpfs outside those directories when Landlock is unavailable (size-capped, discarded with the cell).
- Use any syscall not on the deny list, including ones a future kernel adds. A program that calls `clone3` directly, without a `clone` fallback, fails.
- Consume what the cgroup allows. The host kernel is shared, so there is no defence against kernel vulnerabilities (CLAUDE.md 1.3).

## 5. Files

New native code (about 650 lines): `native/src/caps.{c,h}`, `native/src/seccomp.{c,h}` (table, BPF assembly, a small reference evaluator used by tests and the fuzz target), `native/src/landlock.{c,h}`, `native/src/fuzz_filter.c`.

New TypeScript (about 450 lines): `src/policy/manifest.ts` (schema, clamp, canonical hash), `src/policy/ceiling.ts` (strict policy-file schema). `src/policy/policy.ts` is rewritten to use it.

New tests: `tests/unit/{manifest,ceiling,policy}.test.ts`, `tests/integration/hardening.test.ts`, `tests/escape/probe-{02,04,06,12,13,14,20}-*.test.ts`, and a native filter-table test run by `scripts/check-native.mjs`.

Modified: `native/src/{init,sys,spec,main}.c` and their headers, `native/src/fuzz_spec.c`, `scripts/gen-fuzz-seeds.mjs`, `scripts/build-native.mjs` (new sources, `fuzz_filter` target), `src/gateway/request.ts`, `src/launch/run-cell.ts`, `src/sys/launch-spec.ts`, `src/sys/status.ts`, `src/probe/isolation.ts` (tier 4), `src/collect/classify.ts` (SIGSYS hint), `policy.default.json` (`ceiling`), `docs/SETUP-WSL2.md`, `docs/STAGES.md`, `docs/reports/stage-4.md`, ADR 0005 (raw BPF instead of libseccomp, if chosen) and ADR 0003 (tier 4 filled in).

## 6. Dependencies and privileged actions

- New npm packages: none.
- New native libraries: none on the recommended path (raw BPF, section 11 item 1).
- If the owner chooses libseccomp instead: the owner runs `sudo apt install libseccomp-dev`. Claude will not run it. `build-native.mjs` would then link `libseccomp.a` statically for `release`.
- Privileged actions: **none** on the recommended path.

## 7. Step-by-step plan

1. **Spike (native, scratchpad outside the repository, self-cleaning):** in a real cell, apply the capability drop, `no_new_privs`, a draft raw BPF filter and a Landlock ruleset around `python3`, `bash`, `ls`, a threaded C program and a file starting with `MZ`. Confirm that each layer reads back, that glibc's `clone3` → `clone` fallback works, that init becomes unreadable through `/proc/1/fd`, and that **exec of an `MZ` file fails without starting a Windows process** (section 2 binfmt hypothesis). If any hypothesis fails, stop and amend this prompt.
2. `caps.c` and `landlock.c`, then `seccomp.c` (table, BPF assembly, reference evaluator, table test).
3. Wire into `init.c` (steps 1 to 9 of 4.1). Add the `REQUIRE_MASK` spec key, status records and layer names, and update the spec fuzz invariants.
4. Manifest and ceiling: strict policy schema, manifest schema, clamp, canonical hash, the request compatibility rule. `run-cell` passes the mask and re-checks the receipt. Add the receipt fields and tier 4.
5. Integration tests (each layer read back from inside the cell, the environment scrub, init unreachable), then probes 2, 4, 6, 12, 13, 14 and 20.
6. Both builds, both compilers, `clang-tidy`/`clang-format`, the filter fuzz target, the spec fuzz re-run, `npm run check`, the report and `STAGES.md`.
7. Commit incrementally on `stage/4-hardening`, created at approval from `main` (`32f8110`, where Stage 3 is merged; CLAUDE.md 10).

## 8. Tests and acceptance gate

**Unit and property:**

- Manifest schema: strict, unknown keys rejected, `__proto__` rejected, both `limits` and `manifest` rejected.
- Clamping never exceeds the ceiling, and `require` always contains `require_at_least` (fast-check).
- The canonical hash is stable under key reordering and changes under any value change (fast-check).
- A policy file with an unknown key, or one that cannot be read, refuses.
- The filter table checked against the reference evaluator: every listed syscall is denied; representative allowed ones (`read`, `write`, `openat`, `execve`, plain `clone`, `ioctl(TCGETS)`) are allowed; `clone` with `CLONE_NEWUSER` is denied; a wrong architecture kills.

**Integration (`needs_userns`; a missing feature fails with the probed fact and is never silently skipped):**

- Inside the cell, `/proc/self/status` shows all five capability sets at `0`, `NoNewPrivs: 1` and `Seccomp: 2`. The receipt's `layers` match, and level 4 is reached.
- Init's `/proc/1/status` shows capability sets at `0` and `NoNewPrivs: 1`, read by the payload where permitted. `/proc/1/fd` and `/proc/1/mem` are unreadable. The Stage 2 forged-record scenario is attempted (write a fake `exited 0` through init's descriptor) and fails, and the receipt reflects the real outcome.
- `python3 -c`, `ls`, `sh`, `cat`, a threaded program and `bash` with a pipeline run normally under the full stack.
- Environment: the engine is started with decoy `AWS_ACCESS_KEY_ID`, `SSH_AUTH_SOCK` and `HOME`, and the cell's `env` output contains none of them.
- Manifest: a request for 8192 MB is clamped to the ceiling and listed in `clamped`. `require: ["landlock"]` with Landlock forced unavailable (test-only spec flag, as with Stage 3's force-copy) refuses with `isolation_unavailable` naming `landlock`, and the payload's marker file never appears. The same manifest hashes identically across runs.

**Escape probes (disposable fixture; CLAUDE.md 6.5):**

| Probe | Payload | Pass condition | Layer expected to stop it |
| --- | --- | --- | --- |
| 2 | read `~/.ssh/id_rsa` and print `$AWS_*` (the fixture HOME holds decoys; the engine's environment holds decoy `AWS_*`) | decoys unreadable and absent from the output | private root, environment scrub |
| 4 | `cmd.exe /c whoami` by name and by `/mnt/c/...` path, then exec of a planted `MZ` file in `/workspace` | no Windows process runs; a host-side marker the PE would create never appears | no `/mnt` and no `/init` in the cell (binfmt `P` without `F`), no interop socket |
| 6 | connect to `/var/run/docker.sock`, `/run/WSL/*` and a host abstract Unix socket the harness listens on | no such file / connection refused; the harness's listener sees no connection | private root, net namespace, Landlock abstract-socket scope |
| 12 | `mount -t tmpfs`, `mknod /dev/sda b 8 0`, `chroot /tmp` | all `EPERM` | caps dropped, seccomp (also tested with each alone in the debug build to attribute the stop) |
| 13 | `unshare -U`, `unshare -m`, a `clone(CLONE_NEWUSER)` program, `setns` on an `/proc/self/ns` fd | all `EPERM`; `clone3` returns `ENOSYS` | seccomp, no caps |
| 14 | `bpf(BPF_PROG_LOAD)`, `perf_event_open`, `keyctl(KEYCTL_GET_KEYRING_ID)`, `io_uring_setup` | all `EPERM` | seccomp |
| 20 | request `memory_mb: 8192` and `network.allow: ["evil.example"]` | memory clamped to the ceiling, the domain removed, both listed in `clamped`; no interface but `lo` (down) exists in the cell | ceiling policy, net namespace |

A probe that succeeds against the full stack is a **finding**: it is reported prominently and the stage stops (CLAUDE.md 7). The probes from Stages 1 to 3 are re-run unchanged and must still be stopped.

**Sanitizers and fuzzing:** integration and escape suites on both helper builds (init and the filter run from the same binary). The spec parser fuzz is re-run for at least 5 minutes. The filter fuzz target runs for at least 5 minutes: random syscall numbers, architectures and argument words, asserting that the reference evaluator denies every listed syscall and that the assembled program never jumps out of bounds. The fuzz target checks the assembler, not the kernel; the integration tests check the kernel.

**Definition of done** (CLAUDE.md 0.6): everything above measured and recorded; `npm run check` green; native checks clean; `docs/reports/stage-4.md` with commands, measured numbers (per-probe results, run cost with the hardening layers compared with Stage 3's 10.6 ms median), deviations, limitations, branch and final commit; `docs/STAGES.md` set to `done`; everything committed on `stage/4-hardening` with a clean tree. Nothing pushed or merged by Claude.

## 9. Risks and mitigations

- **The deny list breaks a legitimate program:** step 1 runs a representative set first. The table is data with tests, and the report lists anything that had to stay allowed and why.
- **`clone3` → `ENOSYS`:** glibc and musl fall back to `clone`. This is tested with `python3`, `bash` and a threaded C program. Programs that call `clone3` directly fail, which is stated as a limitation.
- **Init loses capabilities it turns out to need** (for example to kill a payload that changed its own credentials): the payload cannot change credentials without capabilities, and the host's `cgroup.kill` remains the final teardown in any case. The spike checks init's kill and reap path after the drop.
- **Landlock ABI differences between kernels:** the ruleset is built from the probed ABI, the receipt reports it, and the layer is optional by default.
- **Root without capabilities and file ownership:** it cannot `chown` to other ids or override modes it does not own. This is expected and documented. The overlay's files are owned by the mapped uid anyway.
- **Ordering bug leaving a window:** the order in 4.1 is fixed in one function. A debug-build test reads the state back after each step, and the "fail before exec" rule holds.
- **binfmt hypothesis wrong** (a PE does start a Windows process): this would be a finding and the stage stops. The planned mitigation, to be amended in only if needed, is mounting an empty binfmt_misc instance in the cell's user namespace (Linux 6.7+), which shadows the host's registrations.
- **Manifest hash instability:** the canonical form is specified and property-tested.
- **Supply chain:** nothing added on the recommended path.

## 10. Rollback

All work goes on `stage/4-hardening`. Back out with `git revert` or by deleting the branch. No cgroup configuration, system file or package is touched. Temporary cell and workspace directories follow the Stage 2 and 3 cleanup rules.

## 11. Open questions for the owner

**Decisions recorded from the owner (2026-10-17), after approval and outside the hashed text:** item 1 raw BPF (ADR 0005); items 2 to 7 the recommended answers (deny list; Landlock optional; default `require` `caps_dropped`, `no_new_privs`, `seccomp`; today's constants as the ceiling; payload stays uid 0 without capabilities; Stage 3 leftovers stay for a later `fix(stage-3)`); item 8 the owner handles the uncommitted changes, and the branch is created only once the tree is clean.

1. **Raw BPF (recommended) or libseccomp.** Raw BPF needs no package and no `sudo` and keeps the static helper free of a new library; it is a deviation from CLAUDE.md 2 and is recorded as ADR 0005. libseccomp needs `sudo apt install libseccomp-dev` from you.
2. **Deny list (recommended, per the blueprint) or allowlist** for seccomp?
3. **Landlock optional by default (recommended)**, reported but not required, so an older kernel still reaches level 4? Or required by default?
4. **Default `require`**: `caps_dropped`, `no_new_privs`, `seccomp` (recommended). Agree?
5. **Ceiling numbers** for `policy.default.json`: memory 2048 MB, pids 512, CPU 400 %, CPU time 300 s, wall 60 s, output 1024 KB, disk 256 MB, `network_allow` empty, `require_at_least` = the default `require`. These are today's constants (recommended). Keep them?
6. **Payload uid**: keep uid 0 without capabilities (recommended; one mapped id, nothing else gains from a different number), or map the payload to a non-zero uid inside the cell?
7. **Stage 3 open items** (section 3): leave them for a later `fix(stage-3)` on `stage/3-workspace` (recommended), or not at all for now?
8. **Uncommitted changes in `~/aegis-engine`** that are not mine to touch: `src/util/result.ts` (changes `err(code, context)` to `err({code, context})`, edited 2026-10-12; every existing caller still uses the old form, so `npm run check` would fail with it), plus the untracked `request.json` and `docs/AegisEngine_Review_I_IEEE.docx`. At approval I create the stage branch from `main`, and uncommitted changes would come along. Should you commit, stash or revert them first, or do you want the `result.ts` change folded into this stage (it would then need to be in scope here)?
