# ADR 0006: A test-only mask to switch hardening layers off

- Status: accepted (design consequence of the Stage 4 prompt's probe table, within its goal)
- Date: 2026-10-17
- Refines: CLAUDE.md 6.5 (layer-disabling flags). Full ablation (Stage 6) is not built here.

## Context

The Stage 4 prompt asks for escape probes 12, 13 and 14 to be "tested with each alone in the debug
build to attribute the stop", and for a run that requires Landlock to be refused when Landlock is
unavailable. Both need a way to make a layer unavailable on demand. CLAUDE.md 6.5 allows
layer-disabling flags only in builds configured for ablation, compiled out of `release`, behind an
explicit test switch.

## Decision

- The launch-spec key `ABLATE_MASK` (a bitmask over `caps_dropped`, `no_new_privs`, `seccomp`,
  `landlock`) and the `init --ablate <mask>` option exist **only** when the helper is compiled with
  `-DAEGIS_ENABLE_ABLATION=1`. `scripts/build-native.mjs` defines it for `debug-asan` and the
  libFuzzer target, never for `release`. A `release` helper rejects the spec (`spec` layer failure)
  and the init option as unknown.
- An ablated layer is *reported as unavailable* (`layer <name> fail EOPNOTSUPP`) without being
  tried, so the receipt shows the truth and a manifest that requires it is refused as usual.
- The control plane refuses a run that asks for ablation (`RunCellDeps.ablate`) unless
  `AEGIS_TEST_UNSAFE=1` is set in its own environment, so no request can reach this path.
- CLAUDE.md 6.5 also asks for "a fixture path argument". These switches only make the *cell* weaker
  and every use is in a test that runs inside the escape harness's disposable fixture; there is no
  destructive file operation to point at a fixture. The Stage 6 ablation matrix, which does run
  destructive probes with layers off, will add that argument.

## Consequences

- The debug build can attribute a stop to a layer. The first result is already a finding: Landlock
  refuses mount calls by itself, and dropped capabilities alone do not stop `unshare -U`
  (probes 12 and 13).
- The release binary has no code path that weakens a layer.
- Stage 6 replaces or extends this mask rather than starting from nothing.
