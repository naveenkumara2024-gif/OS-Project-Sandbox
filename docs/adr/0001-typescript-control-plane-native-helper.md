# ADR 0001: TypeScript control plane with a small native helper

- Status: accepted (explicit owner request, 2026-10-11)
- Overrides: CLAUDE.md §2 (C++20, "no Node.js runtime", single static binary), §2.1, §2.2, §5.1, §5.2, §7 (tooling rows)
- Supersedes: `docs/prompts/stage-0-scaffold-cpp.md` (never approved)

## Context

The original contract specified C++20 and a single static binary. The owner asked for the project to be TypeScript instead, including CLAUDE.md and all supporting tooling.

The engine's isolation depends on kernel interfaces that Node.js cannot reach from JavaScript: `clone3`/`unshare` with `CLONE_NEW*`, `mount`/`pivot_root`, `capset`/`prctl`, seccomp, Landlock, `openat2` with `RESOLVE_BENEATH`, extended attributes (overlay opaque markers), `CLONE_INTO_CGROUP`. Node.js is also multithreaded (libuv), and `unshare(CLONE_NEWUSER)` fails in a multithreaded process (CLAUDE.md §5.2), so namespace creation cannot happen in-process regardless of FFI.

Options considered:

1. TypeScript control plane + tiny native helper (chosen).
2. Pure TypeScript via FFI (Bun `bun:ffi` / Deno `Deno.dlopen`): rejected, the multithreaded runtime makes the launch path unsound.
3. Pure TypeScript driving `bwrap`/`unshare`/`setpriv` by argument vector: rejected, no custom PID 1, seccomp and receipt guarantees depend on external tool versions, weakens contribution 2.

## Decision

- All orchestration, policy, probe aggregation, termination classification, gateway, MCP server, receipts and tests are **TypeScript** (strict) on **Node.js LTS**.
- A small **native helper** `aegis-cell`, written in **C11** and built static, performs only what Node cannot: namespace creation, root build, `pivot_root`, capability drop, seccomp, Landlock, PID 1 supervision, `openat2`-confined file operations and xattr reads (the last two arrive in Stage 3).
- The helper is spawned by the control plane with an argument vector and inherited file descriptors (no shell). It receives a length-prefixed launch spec over a pipe, **not JSON**, so the helper contains no JSON parser. The control plane owns manifest validation, clamping and hashing.
- Toolchain: `tsc`, `vitest`, `eslint` + `typescript-eslint`, `prettier`, `fast-check`, `zod` (from Stage 1), Jazzer.js for fuzzing (from Stage 1, subject to install-script review). Native: `cc` (GCC or Clang), `clang-tidy`, `clang-format`, `libseccomp` (Stage 4).
- The C++ presets (`debug-asan`, `debug-tsan`, `release`, `fuzz`) become native-helper build modes `release`, `debug-asan` and `fuzz`; `debug-tsan` is dropped because the helper is single-threaded.

## Consequences

- Positive: JSON parsing, schema validation, MCP, HTTP and tests are in a memory-safe language; the launch path is *safer* than in-process `clone3` because the helper is a fresh single-threaded process.
- Negative: the project is no longer 100% TypeScript; two toolchains must be maintained; npm supply-chain exposure is new (mitigated by CLAUDE.md §6.7); path confinement and xattr access cannot be done from Node and must live in the helper.
- The "single static binary" rationale (nothing from the host inside the cell) is preserved: the only executable inside a cell is the static helper, never Node.
- The five contributions (CLAUDE.md §1.2) are unchanged.
- `docs/BLUEPRINT.md` may describe a C++ implementation; deviations are recorded here and in the stage reports, and the blueprint is edited only when the owner asks.
