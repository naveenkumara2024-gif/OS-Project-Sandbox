# WSL2 setup

One-time setup performed by the owner. Claude never runs `sudo` or changes system configuration
(CLAUDE.md 6.6). Sections 1 to 7 are Stage 0, section 8 is Stage 1, section 9 is Stage 2, section 10 is Stage 3; later
stages add their own steps to this file when they need them.

## 1. Requirements

- Windows 11 with WSL2 and an Ubuntu distribution. Check from PowerShell: `wsl -l -v` must show
  `VERSION 2`. WSL1 is unsupported.
- The repository must live on the Linux filesystem, for example `~/aegis-engine`. **Never build or
  run under `/mnt/c`** (CLAUDE.md 3): `node_modules` there is slow and symlink-hostile, and the
  engine must not stage anything on a Windows drive.

## 2. System packages (Ubuntu, run by you)

```bash
sudo apt update
sudo apt install build-essential clang clang-tidy clang-format
sudo apt install libclang-rt-$(clang --version | sed -n 's/.*version \([0-9]*\)\..*/\1/p')-dev
```

The second command installs the Clang sanitizer runtime that matches your Clang (for example
`libclang-rt-21-dev`). Without it the Clang `debug-asan` build fails to link with
`cannot find libclang_rt.asan.a`; the GCC `debug-asan` build is unaffected.

No `libseccomp-dev` is needed: Stage 4 assembles its seccomp filter itself (ADR 0005). The kernel headers do not need to know Landlock ABI 6: the values newer than the installed `linux/landlock.h` come from `native/src/landlock_abi.h`, and each is used only when the running kernel reports the ABI that introduced it (the GitHub runner's Ubuntu 24.04 headers stop at ABI 4). Landlock itself is optional at run time (a run reports whether it was applied).

## 3. Node.js

Install Node.js 22 LTS or newer by a method you trust (nvm, NodeSource or the distribution
package). Confirm with `node --version`. The exact version is recorded in the stage report.

## 4. Get the repository onto ext4

```bash
cd ~
git clone /mnt/c/Users/navas/Downloads/vibecode/sandB aegis-engine   # or move/copy it
cd aegis-engine
git switch stage/0-scaffold
```

## 5. Install dev dependencies (exact pins, no install scripts)

The exact versions are pinned in `package.json` and `package-lock.json`. Install from the lockfile:

```bash
npm ci --ignore-scripts
```

To add a dependency later (only with owner approval, CLAUDE.md 2 and 6.7):
`npm install --save-dev --save-exact --ignore-scripts <package>`.

## 6. Verify Stage 0

```bash
npm ci --ignore-scripts          # reinstall from the lockfile
npm run check                    # tsc, eslint, prettier --check, vitest
npm run build:native             # release (static) and debug-asan, -Werror
npm run check:native             # clang-format --dry-run, clang-tidy
npm run build && node dist/main.js probe
```

Static linking of the release helper:

```bash
file native/build/release/aegis-cell
ldd native/build/release/aegis-cell     # expect: not a dynamic executable
```

Run the helper under the sanitizers (reports any ASan/UBSan finding):

```bash
./native/build/debug-asan/aegis-cell probe
```

Also run the build with the other compiler: `node scripts/build-native.mjs all --cc=gcc` and
`--cc=clang`.

## 7. What to send back

Paste the output of the commands above, in particular the full `aegis probe` JSON, the `file`/`ldd`
lines, and any failure. Claude records them verbatim in `docs/reports/stage-0.md`; nothing is marked
verified until real output exists.

## 8. Stage 1: running a cell

Stage 1 needs no new system packages, no `sudo` and no WSL configuration. It needs unprivileged
user namespaces, which the Stage 0 probe reports as `native.unshare_newuser: true` on a working
machine.

```bash
npm ci --ignore-scripts
node scripts/build-native.mjs all          # release (static-pie) and debug-asan helpers
npm run check                              # includes the integration and escape tests
npm run build
echo '{"id":"demo","command":["/usr/bin/echo","hi"]}' | node dist/main.js run
```

`npm run check` runs real cells, so it fails (it is never skipped) if the helper is not built or the
kernel refuses a namespace. Fuzz the launch-spec parser (needs `libclang-rt-<N>-dev`, see section 2):

```bash
node scripts/build-native.mjs fuzz --cc=clang
mkdir -p /tmp/spec-corpus && cp tests/fuzz/corpus/spec/* /tmp/spec-corpus/
./native/build/fuzz/fuzz-spec -max_total_time=300 -max_len=70000 /tmp/spec-corpus
```

**Until Stage 4, do not run untrusted code outside the test fixtures.** The Stage 1 cell has
namespace-local capabilities and exposes the host's `/usr` read-only (prompt section 4.9).

## 9. Stage 2: resource limits need a delegated cgroup

Stage 2 needs **no `sudo` and no system change** on a WSL2 distribution with systemd enabled
(`[boot] systemd=true` in `/etc/wsl.conf`, which this machine has). It does need the engine to run
inside the cgroup subtree that systemd's user manager delegates to you:

```bash
cat /proc/self/cgroup                       # a plain WSL shell shows 0::/init.scope: outside it
systemd-run --user --scope --quiet --collect -- node dist/main.js run --file request.json
```

From `/init.scope` the kernel refuses to place a process into your delegated subtree (it needs
write access to the common ancestor), so `aegis run` returns `isolation_unavailable` with layer
`cgroup_placement` and this command in the `hint`. It does not fall back to weaker limits.

`npm test` and `npm run check` do this for you through `scripts/run-in-scope.mjs` (set
`AEGIS_NO_SCOPE=1` to bypass it, for example when you are already in a scope). GitHub's hosted
runners may not provide a systemd user manager; if they do not, the integration tests fail by
design rather than skip.

Check what the engine sees, including a real self-test cell and its receipt:

```bash
systemd-run --user --scope --quiet --collect -- node dist/main.js probe | head -80
```

Cell cgroups live under `user@1000.service/aegis-cells/cell-<pid>-<id>` and are removed after each
run; leftovers from a crashed engine are removed by the reaper at the next `aegis run`. To look by
hand: `ls /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/aegis-cells`.

## 10. Stage 3: workspaces, commit and discard

No new system packages, no `sudo`: `rsync` and `wslpath` are already present, and unprivileged
overlayfs works inside a cell on this kernel (the Stage 3 report records the measurement).

Host directories are only ever ingested from roots you list in `policy.default.json`
(`ingest_roots`), which the engine reads and never writes; `commit_roots` (defaults to
`ingest_roots`) lists where `aegis commit` may write. Both start empty, so nothing is allowed until
you add a path. Set `AEGIS_POLICY_FILE` to use another file (for tests).

```bash
# run with a workspace (host directory) and inline files; the response carries `changes`
systemd-run --user --scope --quiet --collect -- node dist/main.js run --file request.json
# review, then write only the paths you approve; a git hook or a symlink is always refused
node dist/main.js commit <run-id> --dest <allowed root> [--paths a.txt,sub/b.txt]
# or throw the cell's changes away without touching the project
node dist/main.js discard <run-id>
```

A run's workspace lives in `$TMPDIR/aegis-workspace-<run-id>` until `commit`/`discard` (Stage 5
adds sessions and idle expiry). A deletion in the change list is reported by `commit`, never
applied automatically.

## Environment variables

| Variable | Effect |
| --- | --- |
| `AEGIS_CELL_BIN` | Absolute path of the helper, overriding `native/build/release/aegis-cell`. The chosen path and its source appear in the probe output. |
| `AEGIS_CC` | Compiler used by `scripts/build-native.mjs` (default `cc`; `--cc=` wins). |
| `AEGIS_POLICY_FILE` | Absolute path of the policy file, overriding `policy.default.json` at the repository root. |
| `AEGIS_NO_SCOPE` | `1` makes `scripts/run-in-scope.mjs` run its command directly instead of through `systemd-run --user --scope`. |
