// The seven resource limits a manifest can ask for, their defaults, and the sanity bounds a policy
// file may set for them. These are code, not policy: the *ceiling* (what a run may actually have)
// is data in the human-owned policy file (CLAUDE.md 6.4).

export const LIMIT_NAMES = [
  'wall_ms',
  'output_kb',
  'memory_mb',
  'pids',
  'cpu_percent',
  'cpu_ms',
  'disk_mb',
] as const;

export type LimitName = (typeof LIMIT_NAMES)[number];

export type Limits = Readonly<Record<LimitName, number>>;

/** What a run gets for a limit its manifest does not mention (before the ceiling is applied). */
export const DEFAULT_LIMITS: Limits = {
  wall_ms: 10_000,
  output_kb: 256,
  memory_mb: 512,
  pids: 128,
  cpu_percent: 100,
  cpu_ms: 10_000,
  disk_mb: 16,
};

/**
 * Upper bound for a *ceiling* value in the policy file, so a typo cannot make the ceiling
 * meaningless or overflow a kernel interface. disk_mb is bounded by the largest tmpfs the launch
 * spec accepts (1 GiB, SPEC_MAX_TMPFS_BYTES).
 */
export const LIMIT_SANITY_MAX: Limits = {
  wall_ms: 3_600_000,
  output_kb: 65_536,
  memory_mb: 1_048_576,
  pids: 4_194_304,
  cpu_percent: 6_400,
  cpu_ms: 86_400_000,
  disk_mb: 1_024,
};

/** A request value larger than this is rejected as malformed rather than clamped. */
export const REQUEST_LIMIT_MAX = 1_000_000_000_000;
