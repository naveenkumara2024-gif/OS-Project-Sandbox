import { z } from 'zod';
import { RECEIPT_LAYERS, type ReceiptLayer } from '../probe/isolation.js';
import { err, ok, type Result } from '../util/result.js';
import { LIMIT_NAMES, LIMIT_SANITY_MAX, type LimitName, type Limits } from './limits.js';

// The ceiling policy file (CLAUDE.md 6.4): owned by the human, outside every workspace, never
// mounted into a cell. It is parsed strictly: a byte cap before parsing, unknown keys rejected,
// dangerous keys rejected. A file that cannot be read or does not validate refuses the run; there
// is no fallback to built-in defaults (contribution 4, fail closed).

export const MAX_POLICY_BYTES = 64 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Hostname syntax per RFC 1123 labels, lower-case, at most 253 characters. */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
export const hostnameSchema = z
  .string()
  .transform((s) => s.toLowerCase())
  .refine((s) => HOSTNAME.test(s), 'not a valid hostname');

export const layerSchema = z.enum(RECEIPT_LAYERS);

const pathList = z
  .array(
    z
      .string()
      .min(1)
      .max(4096)
      .refine((s) => !s.includes('\0')),
  )
  .max(64);

function ceilingLimit(name: LimitName): z.ZodNumber {
  return z.number().int().min(1).max(LIMIT_SANITY_MAX[name]);
}

const ceilingLimits = z.strictObject({
  wall_ms: ceilingLimit('wall_ms'),
  output_kb: ceilingLimit('output_kb'),
  memory_mb: ceilingLimit('memory_mb'),
  pids: ceilingLimit('pids'),
  cpu_percent: ceilingLimit('cpu_percent'),
  cpu_ms: ceilingLimit('cpu_ms'),
  disk_mb: ceilingLimit('disk_mb'),
});

const policyFileSchema = z.strictObject({
  _comment: z.string().max(4096).optional(),
  ingest_roots: pathList.default([]),
  ingest_excludes: pathList.default([]),
  commit_roots: pathList.optional(),
  ceiling: z.strictObject({
    limits: ceilingLimits,
    network_allow: z.array(hostnameSchema).max(256),
    require_at_least: z.array(layerSchema).max(RECEIPT_LAYERS.length),
  }),
});

/** What a run may be given, at most. */
export interface Ceiling {
  readonly limits: Limits;
  /** Lower-case hostnames a manifest may list; anything else is removed and reported. */
  readonly networkAllow: readonly string[];
  /** Layers every run must have, whatever its own manifest asks for. */
  readonly requireAtLeast: readonly ReceiptLayer[];
}

export interface PolicyFile {
  readonly ingestRoots: readonly string[];
  readonly ingestExcludes: readonly string[];
  readonly commitRoots: readonly string[];
  readonly ceiling: Ceiling;
}

/** Parses the bytes of a policy file. The caller hashes the same bytes for `ceiling_sha256`. */
export function parsePolicyFile(bytes: Uint8Array): Result<PolicyFile> {
  if (bytes.length > MAX_POLICY_BYTES) {
    return err('E2BIG', 'policy file exceeds the byte limit');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8'), (key: string, value: unknown) => {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new Error('forbidden key');
      }
      return value;
    });
  } catch {
    return err('EINVAL', 'policy file is not valid JSON, or contains a forbidden key');
  }
  const parsed = policyFileSchema.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.code}`)
      .join('; ');
    return err('EINVAL', `policy schema violation at ${where}`);
  }
  const d = parsed.data;
  const limits = {} as Record<LimitName, number>;
  for (const name of LIMIT_NAMES) limits[name] = d.ceiling.limits[name];
  return ok({
    ingestRoots: d.ingest_roots,
    ingestExcludes: d.ingest_excludes,
    // Absent commit_roots keeps Stage 3's behaviour: the ingest roots double as commit roots.
    commitRoots: d.commit_roots ?? d.ingest_roots,
    ceiling: {
      limits,
      networkAllow: [...new Set(d.ceiling.network_allow)].sort(),
      requireAtLeast: [...new Set(d.ceiling.require_at_least)].sort(),
    },
  });
}
