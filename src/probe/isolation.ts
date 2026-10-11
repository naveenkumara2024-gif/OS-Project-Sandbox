import { HELPER_LAYERS } from '../sys/status.js';

// The isolation receipt vocabulary and the level function (ADR 0003). Every value is produced
// from something the helper or the control plane observed after the fact, never from
// configuration (CLAUDE.md 1.2 item 2).

/** Layers established by the control plane: limits written to the cgroup and read back. */
export const CGROUP_LAYERS = ['cgroup_memory', 'cgroup_pids', 'cgroup_cpu', 'cgroup_kill'] as const;

export const RECEIPT_LAYERS = [...HELPER_LAYERS, ...CGROUP_LAYERS] as const;

export type ReceiptLayer = (typeof RECEIPT_LAYERS)[number];

export type ReceiptLayers = Readonly<Record<ReceiptLayer, boolean>>;

/** Every layer a run can establish without asking for a workspace (everything but `overlay`). */
export const NON_WORKSPACE_LAYERS: readonly ReceiptLayer[] = RECEIPT_LAYERS.filter(
  (l) => l !== 'overlay',
);

/**
 * Tiers, innermost first. The level is the number of consecutive tiers whose layers are all true.
 * Tier 3 (`overlay`, Stage 3) is only satisfied by a run that actually mounted an overlay
 * workspace; a run with no workspace request, or one that fell back to a plain copy, simply caps
 * at level 2 rather than claiming a tier it never attempted (CLAUDE.md 1.2 item 2). Tier 4
 * (capability drop, no_new_privs, seccomp) is appended by Stage 4.
 * `cgroup_cpu` and `cgroup_kill` are reported but belong to no tier: CPU delegation is optional
 * and there is a per-pid fallback for the kill.
 */
export const TIERS: readonly (readonly ReceiptLayer[])[] = [
  ['userns', 'pidns', 'mountns', 'netns', 'root', 'proc', 'dev'],
  ['ipcns', 'utsns', 'cgroupns', 'timens', 'init', 'cgroup_memory', 'cgroup_pids'],
  ['overlay'],
];

export function emptyReceiptLayers(): Record<ReceiptLayer, boolean> {
  const out = {} as Record<ReceiptLayer, boolean>;
  for (const l of RECEIPT_LAYERS) out[l] = false;
  return out;
}

export function isolationLevel(layers: ReceiptLayers): number {
  let level = 0;
  for (const tier of TIERS) {
    if (!tier.every((l) => layers[l])) break;
    level += 1;
  }
  return level;
}
