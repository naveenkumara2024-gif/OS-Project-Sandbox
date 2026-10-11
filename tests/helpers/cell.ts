import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CellResult } from '../../src/launch/run-cell.js';
import { runCell, type RunCellDeps } from '../../src/launch/run-cell.js';
import { realPlanEnv, type PlanEnv } from '../../src/launch/rootfs-plan.js';
import { parseRunRequest, type RunRequest } from '../../src/gateway/request.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface HelperBuild {
  readonly name: 'release' | 'debug-asan';
  readonly path: string;
}

/**
 * The helper builds integration tests run against. A missing build is a failure with a clear
 * message, never a silent skip (CLAUDE.md 7): run `npm run build:native` first.
 */
export function helperBuilds(): HelperBuild[] {
  const all: HelperBuild[] = [
    { name: 'release', path: join(root, 'native', 'build', 'release', 'aegis-cell') },
    { name: 'debug-asan', path: join(root, 'native', 'build', 'debug-asan', 'aegis-cell') },
  ];
  const missing = all.filter((b) => !existsSync(b.path));
  if (missing.length > 0) {
    throw new Error(
      `native helper not built: ${missing.map((m) => m.path).join(', ')} (run: npm run build:native)`,
    );
  }
  return all;
}

export function request(command: string[], extra: Record<string, unknown> = {}): RunRequest {
  const r = parseRunRequest(JSON.stringify({ id: 'test', command, ...extra }));
  if (!r.ok) {
    throw new Error(`test request invalid: ${r.error.context}`);
  }
  return r.value;
}

export async function runIn(
  helper: HelperBuild,
  req: RunRequest,
  planEnv: PlanEnv = realPlanEnv(),
  tmpParent?: string,
): Promise<CellResult> {
  const r = await runCell(req, {
    helperPath: helper.path,
    planEnv,
    ...(tmpParent === undefined ? {} : { tmpParent }),
  });
  if (!r.ok) {
    throw new Error(`runCell failed: ${r.error.code}: ${r.error.context}`);
  }
  return r.value;
}

/** Runs `sh -c script` in a cell. */
export function sh(
  helper: HelperBuild,
  script: string,
  extra: Record<string, unknown> = {},
  tmpParent?: string,
) {
  return runIn(helper, request(['/usr/bin/sh', '-c', script], extra), realPlanEnv(), tmpParent);
}

/** Like runIn, with the control-plane test seams (fake cgroup text, uid, and so on). */
export async function runWith(
  helper: HelperBuild,
  req: RunRequest,
  extra: Partial<RunCellDeps>,
): Promise<CellResult> {
  const r = await runCell(req, { helperPath: helper.path, planEnv: realPlanEnv(), ...extra });
  if (!r.ok) {
    throw new Error(`runCell failed: ${r.error.code}: ${r.error.context}`);
  }
  return r.value;
}

/**
 * CLAUDE.md 6.5: fork-bomb and memory probes run only with the cgroup layer active. This runs a
 * real cell and refuses (throws, so the test fails as inconclusive) unless the memory and pids
 * limits were established and verified.
 */
export async function requireCgroupLimits(helper: HelperBuild): Promise<void> {
  const r = await runIn(helper, request(['/usr/bin/true']));
  const l = r.isolation.layers;
  if (!l.cgroup_memory || !l.cgroup_pids) {
    throw new Error(
      `inconclusive: cgroup limits are not active (memory=${String(l.cgroup_memory)}, pids=${String(l.cgroup_pids)}); refusing to run a resource probe. ${r.hint ?? ''}`,
    );
  }
}
