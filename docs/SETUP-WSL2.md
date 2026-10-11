# WSL2 setup

One-time setup performed by the owner. Claude never runs `sudo` or changes system configuration
(CLAUDE.md 6.6). Everything here is for Stage 0; later stages add systemd and cgroup delegation
steps to this file when they need them.

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

No `libseccomp-dev`, `rsync` or fuzzing runtime is needed yet; later stages list theirs.

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

## Environment variables

| Variable | Effect |
| --- | --- |
| `AEGIS_CELL_BIN` | Absolute path of the helper, overriding `native/build/release/aegis-cell`. The chosen path and its source appear in the probe output. |
| `AEGIS_CC` | Compiler used by `scripts/build-native.mjs` (default `cc`; `--cc=` wins). |
