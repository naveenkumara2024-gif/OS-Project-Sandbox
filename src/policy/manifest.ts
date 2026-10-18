import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ReceiptLayer } from '../probe/isolation.js';
import { canonicalJson } from './canonical.js';
import { hostnameSchema, layerSchema, type Ceiling } from './ceiling.js';
import {
  DEFAULT_LIMITS,
  LIMIT_NAMES,
  REQUEST_LIMIT_MAX,
  type LimitName,
  type Limits,
} from './limits.js';

// Cell manifests as policy-as-data (CLAUDE.md 1.2 item 4). A request may carry a manifest: the
// limits it wants, its network request, its workspace mode and the layers it requires. The
// manifest is untrusted. It is validated strictly, clamped to the ceiling (it may ask for less,
// never more), and the *resolved* manifest is hashed with canonical JSON. The hash, the resolved
// values and every clamp are echoed in the receipt.

/** Layers every manifest requires unless it says more (the ceiling's `require_at_least` is added). */
export const DEFAULT_REQUIRE: readonly ReceiptLayer[] = ['caps_dropped', 'no_new_privs', 'seccomp'];

const MAX_ALLOW_DOMAINS = 16;

const limitValue = z.number().int().min(1).max(REQUEST_LIMIT_MAX);

export const requestedLimitsSchema = z.strictObject({
  wall_ms: limitValue.optional(),
  output_kb: limitValue.optional(),
  memory_mb: limitValue.optional(),
  pids: limitValue.optional(),
  cpu_percent: limitValue.optional(),
  cpu_ms: limitValue.optional(),
  disk_mb: limitValue.optional(),
});

export const manifestRequestSchema = z.strictObject({
  limits: requestedLimitsSchema.optional(),
  // Only "none" exists until the egress broker (Stage 5). The allowlist is recorded, clamped
  // against the ceiling, and reported, but grants no network access yet.
  network: z
    .strictObject({
      // "brokered" gives the cell one audited path to allowlisted hosts through the egress broker
      // (Stage 5); "none" (the default) gives it no interface at all.
      mode: z.enum(['none', 'brokered']).optional(),
      allow: z.array(hostnameSchema).max(MAX_ALLOW_DOMAINS).optional(),
    })
    .optional(),
  workspace: z.strictObject({ mode: z.literal('overlay').optional() }).optional(),
  require: z.array(layerSchema).max(32).optional(),
});

/** What the request asked for, after schema validation and before the ceiling is applied. */
export interface ManifestRequest {
  readonly limits: Readonly<Partial<Record<LimitName, number>>>;
  readonly networkMode: 'none' | 'brokered';
  readonly networkAllow: readonly string[];
  /** Null when the request did not list `require`, so the default applies. */
  readonly require: readonly ReceiptLayer[] | null;
}

export const EMPTY_MANIFEST_REQUEST: ManifestRequest = {
  limits: {},
  networkMode: 'none',
  networkAllow: [],
  require: null,
};

export function toManifestRequest(m: z.infer<typeof manifestRequestSchema>): ManifestRequest {
  const limits: Partial<Record<LimitName, number>> = {};
  for (const name of LIMIT_NAMES) {
    const v = m.limits?.[name];
    if (v !== undefined) limits[name] = v;
  }
  return {
    limits,
    networkMode: m.network?.mode ?? 'none',
    networkAllow: m.network?.allow ?? [],
    require: m.require ?? null,
  };
}

export interface ResolvedManifest {
  readonly limits: Limits;
  readonly network: { readonly mode: 'none' | 'brokered'; readonly allow: readonly string[] };
  readonly workspace: { readonly mode: 'overlay' };
  /** Sorted, without duplicates: the request's set plus the ceiling's `require_at_least`. */
  readonly require: readonly ReceiptLayer[];
}

export interface Clamp {
  readonly field: string;
  readonly requested: number | string;
  /** The value the run got, or null when the requested item was removed. */
  readonly granted: number | string | null;
}

export interface Resolution {
  readonly manifest: ResolvedManifest;
  readonly clamped: readonly Clamp[];
  readonly sha256: string;
}

/** Applies the ceiling. Pure, and total: every input yields a manifest within the ceiling. */
export function resolveManifest(req: ManifestRequest, ceiling: Ceiling): Resolution {
  const clamped: Clamp[] = [];
  const limits = {} as Record<LimitName, number>;
  for (const name of LIMIT_NAMES) {
    const wanted = req.limits[name] ?? DEFAULT_LIMITS[name];
    const max = ceiling.limits[name];
    if (wanted > max) {
      limits[name] = max;
      clamped.push({ field: `limits.${name}`, requested: wanted, granted: max });
    } else {
      limits[name] = wanted;
    }
  }

  const allowed = new Set(ceiling.networkAllow);
  const allow: string[] = [];
  for (const domain of [...new Set(req.networkAllow)].sort()) {
    if (allowed.has(domain)) {
      allow.push(domain);
    } else {
      clamped.push({ field: 'network.allow', requested: domain, granted: null });
    }
  }

  // A brokered cell with nothing left on its allowlist would have a proxy that refuses everything;
  // it becomes a plain air-gapped cell, and the receipt says so.
  let mode = req.networkMode;
  if (mode === 'brokered' && allow.length === 0) {
    mode = 'none';
    clamped.push({ field: 'network.mode', requested: 'brokered', granted: 'none' });
  }

  const require = [
    ...new Set<ReceiptLayer>([...(req.require ?? DEFAULT_REQUIRE), ...ceiling.requireAtLeast]),
  ].sort();

  const manifest: ResolvedManifest = {
    limits,
    network: { mode, allow },
    workspace: { mode: 'overlay' },
    require,
  };
  return { manifest, clamped, sha256: manifestSha256(manifest) };
}

/** SHA-256 (hex) of the canonical JSON of a resolved manifest. */
export function manifestSha256(m: ResolvedManifest): string {
  const text = canonicalJson({
    limits: { ...m.limits },
    network: { mode: m.network.mode, allow: [...m.network.allow] },
    workspace: { mode: m.workspace.mode },
    require: [...m.require],
  });
  if (!text.ok) {
    // Unreachable: every value above is a string or a safe integer by construction.
    throw new TypeError(`manifest is not canonicalisable: ${text.error.context}`);
  }
  return createHash('sha256').update(text.value, 'utf8').digest('hex');
}
