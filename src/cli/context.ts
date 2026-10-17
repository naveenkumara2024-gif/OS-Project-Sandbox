import { appendFileSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../engine/engine.js';
import {
  ensureParent,
  locateDelegation,
  pidIsAlive,
  realCgroupFs,
  reapOrphanCells,
} from '../launch/cgroup.js';
import { realPlanEnv } from '../launch/rootfs-plan.js';
import { loadPolicy, type Policy } from '../policy/policy.js';
import { checkExecutable, locateHelper, moduleDir } from '../sys/helper.js';
import { lineLogger, nullLogger, type Logger } from '../util/logger.js';
import { err, ok, type Result } from '../util/result.js';
import { ensurePrivateDir } from '../util/state-dir.js';
import { reapStaleTempDirs } from '../util/tempdir.js';

// Shared setup for the command-line modes: where the policy lives, where the helper is, the state
// directory, and building an Engine from them.

// sysexits.h values, spelled out so each exit status is documented where it is used.
export const EX_USAGE = 64;
export const EX_DATAERR = 65;
export const EX_SOFTWARE = 70;

/**
 * The human-owned policy file: `AEGIS_POLICY_FILE`, else `$XDG_CONFIG_HOME/aegis/policy.json`,
 * else `~/.config/aegis/policy.json`. There is deliberately no fallback to the copy in the
 * repository: in a harness setup the repository is usually the workspace the agent can write to,
 * and the ceiling must live outside every workspace (CLAUDE.md 6.4).
 */
export function policyPath(env: NodeJS.ProcessEnv): string {
  const explicit = env['AEGIS_POLICY_FILE'];
  if (explicit !== undefined && explicit !== '') return explicit;
  const xdg = env['XDG_CONFIG_HOME'];
  const base =
    xdg !== undefined && xdg.startsWith('/') ? xdg : join(env['HOME'] ?? homedir(), '.config');
  return join(base, 'aegis', 'policy.json');
}

/** An unreadable or invalid policy is an error: there is no built-in fallback. */
export function loadActivePolicy(env: NodeJS.ProcessEnv = process.env): Result<Policy> {
  return loadPolicy(policyPath(env));
}

/** `$XDG_STATE_HOME/aegis` (default `~/.local/state/aegis`), created 0700. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): Result<string> {
  const xdg = env['XDG_STATE_HOME'];
  const base =
    xdg !== undefined && xdg.startsWith('/')
      ? xdg
      : join(env['HOME'] ?? homedir(), '.local', 'state');
  const dir = join(base, 'aegis');
  // The parent (~/.local/state) is the user's own; only our leaf is created and checked.
  const ok1 = ensurePrivateDir(dir);
  return ok1.ok ? ok(dir) : ok1;
}

/** A logger that appends to `engine.log` in the state directory (0600), or stderr on failure. */
export function fileLogger(env: NodeJS.ProcessEnv = process.env): Logger {
  const dir = stateDir(env);
  if (!dir.ok) {
    return lineLogger((l) => process.stderr.write(l));
  }
  const file = join(dir.value, 'engine.log');
  return lineLogger((l) => {
    try {
      appendFileSync(file, l, { mode: 0o600 });
    } catch {
      process.stderr.write(l);
    }
  });
}

export function stderrLogger(): Logger {
  return lineLogger((l) => process.stderr.write(l));
}

/** Removes cells and directories left by engine processes that no longer exist. */
export async function reapOrphans(): Promise<void> {
  const fs = realCgroupFs();
  try {
    const text = readFileSync('/proc/self/cgroup', 'utf8');
    const del = locateDelegation(fs, process.getuid?.() ?? -1, text);
    if (del.ok) {
      const parent = ensureParent(fs, del.value.root);
      if (parent.ok) {
        await reapOrphanCells(fs, parent.value.path);
      }
    }
  } catch {
    // Reaping is best effort: a failure here must not stop a run, and the next run retries.
  }
  reapStaleTempDirs(tmpdir(), pidIsAlive);
}

export interface OpenedEngine {
  readonly engine: Engine;
  readonly policy: Policy;
  readonly helperPath: string;
}

export type OpenError = {
  readonly kind: 'policy' | 'helper';
  readonly code: string;
  readonly context: string;
};

/** Loads the policy, finds the helper and builds an engine. Fails closed on either. */
export function openEngine(
  env: NodeJS.ProcessEnv,
  logger: Logger = nullLogger,
): Result<OpenedEngine> & { readonly kind?: 'policy' | 'helper' } {
  const policy = loadActivePolicy(env);
  if (!policy.ok) return { ...policy, kind: 'policy' };
  const helper = locateHelper(env, moduleDir());
  if (!helper.ok) return { ...helper, kind: 'helper' };
  const exec = checkExecutable(helper.value.path);
  if (!exec.ok) return { ...exec, kind: 'helper' };
  // The egress audit copy goes to the state directory when there is one (a brokered cell only).
  const state = stateDir(env);
  return ok({
    engine: new Engine({
      helperPath: helper.value.path,
      planEnv: realPlanEnv(),
      policy: policy.value,
      logger,
      ...(state.ok
        ? { runCellExtras: { broker: { auditFile: join(state.value, 'audit.jsonl') } } }
        : {}),
    }),
    policy: policy.value,
    helperPath: helper.value.path,
  });
}

export function refusedForPolicy(code: string): {
  readonly termination: { readonly cause: 'isolation_unavailable'; readonly layer: 'policy' };
  readonly error: {
    readonly code: 'isolation_unavailable';
    readonly layer: 'policy';
    readonly errno: string;
  };
  readonly hint: string;
} {
  return {
    termination: { cause: 'isolation_unavailable', layer: 'policy' },
    error: { code: 'isolation_unavailable', layer: 'policy', errno: code },
    hint: 'the ceiling policy file could not be read or is invalid (set AEGIS_POLICY_FILE or create ~/.config/aegis/policy.json); the command was not run',
  };
}

export { err };
