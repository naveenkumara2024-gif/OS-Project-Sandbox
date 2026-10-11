import { readFileSync } from 'node:fs';
import { parseRunRequest } from '../gateway/request.js';
import {
  CGROUP_MOUNT,
  ensureParent,
  locateDelegation,
  realCgroupFs,
  type CgroupFs,
} from '../launch/cgroup.js';
import { runCell } from '../launch/run-cell.js';
import { realPlanEnv } from '../launch/rootfs-plan.js';
import { parseSelfCgroup } from './procfs.js';
import type { ReceiptLayers } from './isolation.js';

// The Stage 2 part of `aegis probe`: cgroup facts and a real self-test cell (prompt section 4.9).
// There is no cache: every run builds its own receipt, which is stronger than a cached probe.

export interface IsolationReport {
  readonly cgroup: {
    readonly v2: boolean;
    readonly engine_cgroup: string | null;
    readonly delegation_root: string | null;
    readonly inside_delegated_subtree: boolean;
    readonly can_create_cell_group: boolean;
    readonly parent_controllers: readonly string[];
    readonly error: { readonly code: string; readonly context: string } | null;
  };
  readonly self_test: {
    readonly ran: boolean;
    readonly cause: string | null;
    readonly level: number | null;
    readonly layers: ReceiptLayers | null;
    readonly wall_ms: number | null;
    readonly hint: string | null;
    readonly error: string | null;
  };
}

export async function collectIsolationReport(
  helperPath: string | null,
  fs: CgroupFs = realCgroupFs(),
): Promise<IsolationReport> {
  let text = '';
  try {
    text = readFileSync('/proc/self/cgroup', 'utf8');
  } catch {
    text = '';
  }
  const v2Path = parseSelfCgroup(text).v2Path;
  const uid = process.getuid?.() ?? -1;

  let root: string | null = null;
  let inside = false;
  let canCreate = false;
  let controllers: string[] = [];
  let error: { code: string; context: string } | null = null;

  const del = locateDelegation(fs, uid, text, CGROUP_MOUNT);
  if (del.ok) {
    root = del.value.root;
    inside = true;
    const parent = ensureParent(fs, root);
    if (parent.ok) {
      canCreate = true;
      controllers = Object.entries(parent.value.controllers)
        .filter(([, on]) => on)
        .map(([name]) => name);
    } else {
      error = parent.error;
    }
  } else {
    error = del.error;
  }

  const selfTest: IsolationReport['self_test'] = await (async () => {
    const none = {
      ran: false,
      cause: null,
      level: null,
      layers: null,
      wall_ms: null,
      hint: null,
      error: null,
    };
    if (helperPath === null) {
      return { ...none, error: 'helper not available' };
    }
    const req = parseRunRequest(
      JSON.stringify({
        id: 'self-test',
        command: ['/usr/bin/true'],
        limits: { wall_ms: 5000 },
      }),
    );
    if (!req.ok) {
      return { ...none, error: req.error.context };
    }
    const r = await runCell(req.value, { helperPath, planEnv: realPlanEnv() });
    if (!r.ok) {
      return { ...none, error: `${r.error.code}: ${r.error.context}` };
    }
    return {
      ran: true,
      cause: r.value.termination.cause,
      level: r.value.isolation.level,
      layers: r.value.isolation.layers,
      wall_ms: r.value.usage.wall_ms,
      hint: r.value.hint,
      error: null,
    };
  })();

  return {
    cgroup: {
      v2: v2Path !== null,
      engine_cgroup: v2Path,
      delegation_root: root,
      inside_delegated_subtree: inside,
      can_create_cell_group: canCreate,
      parent_controllers: controllers,
      error,
    },
    self_test: selfTest,
  };
}
