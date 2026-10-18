import { loadPolicy, type Policy } from '../../src/policy/policy.js';
import type { Ceiling } from '../../src/policy/ceiling.js';
import {
  Engine,
  type EngineDeps,
  type EngineReceipt,
  type RunHandle,
} from '../../src/engine/engine.js';
import type { RunEvent } from '../../src/engine/events.js';
import { realPlanEnv } from '../../src/launch/rootfs-plan.js';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Result } from '../../src/util/result.js';
import { request, type HelperBuild } from './cell.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** policy.default.json with the roots and ceiling fields a test needs replaced. */
export function testPolicy(
  over: {
    readonly ingestRoots?: readonly string[];
    readonly commitRoots?: readonly string[];
    readonly ceiling?: Partial<Ceiling>;
  } = {},
): Policy {
  const p = loadPolicy(join(root, 'policy.default.json'));
  if (!p.ok) throw new Error(`policy.default.json is invalid: ${p.error.context}`);
  return {
    ...p.value,
    ingestRoots: over.ingestRoots ?? p.value.ingestRoots,
    ingestExcludes: [],
    commitRoots: over.commitRoots ?? over.ingestRoots ?? p.value.commitRoots,
    ceiling: { ...p.value.ceiling, ...over.ceiling },
  };
}

export function makeEngine(
  helper: HelperBuild,
  parent: string,
  over: Partial<EngineDeps> & { readonly policy?: Policy } = {},
): Engine {
  return new Engine({
    helperPath: helper.path,
    planEnv: realPlanEnv(),
    policy: over.policy ?? testPolicy(),
    workspaceParent: parent,
    ...over,
  });
}

export async function drain(handle: RunHandle): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of handle.events.subscribe()) out.push(e);
  return out;
}

/** Starts a run and waits for its receipt. */
export async function runAndWait(
  engine: Engine,
  command: string[],
  extra: Record<string, unknown> = {},
  session?: string | null,
): Promise<EngineReceipt> {
  const started = engine.startRun({
    request: request(command, extra),
    ...(session === undefined ? {} : { session }),
    idMode: 'server',
  });
  if (!started.ok) throw new Error(`startRun: ${started.error.code}: ${started.error.context}`);
  const r: Result<EngineReceipt> = await started.value.result;
  if (!r.ok) throw new Error(`run failed: ${r.error.code}: ${r.error.context}`);
  return r.value;
}
