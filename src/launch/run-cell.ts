import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classify,
  errnoName,
  errnoNumber,
  hintFor,
  type HintLimits,
  type LimitHit,
  type Termination,
} from '../collect/classify.js';
import type { RunRequest } from '../gateway/request.js';
import type { Ceiling } from '../policy/ceiling.js';
import type { Limits } from '../policy/limits.js';
import { resolveManifest, type Clamp, type ResolvedManifest } from '../policy/manifest.js';
import { diffCopyResult, diffOverlayUpper, treeBytes, type Change } from '../collect/diff.js';
import {
  resolveIngestSource,
  rsyncIngest,
  writeInlineFiles,
  type IngestPolicy,
} from '../stage/ingest.js';
import { planWorkspace } from './workspace-plan.js';
import { emptyReceiptLayers, isolationLevel, type ReceiptLayers } from '../probe/isolation.js';
import { superviseCell, type PollVerdict } from '../supervise/cell-supervisor.js';
import { encodeLaunchSpec, REQUIRE_BITS, type LaunchSpec } from '../sys/launch-spec.js';
import { HELPER_LAYERS, parseStatus } from '../sys/status.js';
import { err, errFromException, ok, type Result } from '../util/result.js';
import { TempDir } from '../util/tempdir.js';
import {
  CellCgroup,
  ensureParent,
  locateDelegation,
  realCgroupFs,
  type CgroupFs,
  type CgroupLayers,
} from './cgroup.js';
import { planUsr, type PlanEnv } from './rootfs-plan.js';

/** Fixed, not caller-controlled (CLAUDE.md 6.1 item 5); the request may add other names. */
export const CELL_PATH = '/usr/bin:/bin';
export const CELL_HOSTNAME = 'aegis';
export const ROOT_TMPFS_BYTES = 64 * 1024 * 1024;

// Best-effort: do not offer the control plane's own runtime inside a cell (CLAUDE.md 6.1 item 2).
// The native side only masks what exists. This is not a security boundary (prompt section 4.9).
const MASK_FILES = ['/usr/bin/node', '/usr/bin/nodejs'];
const MASK_DIRS = ['/usr/include/node', '/usr/lib/node_modules'];

/** How long after the kill the cell gets to report `populated 0` before it is called stuck. */
const EMPTY_WAIT_MS = 5000;

export interface CellResult {
  readonly id: string;
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly termination: Termination;
  readonly usage: {
    readonly wall_ms: number;
    readonly cpu_ms: number | null;
    readonly memory_peak_bytes: number | null;
    readonly pids_peak: number | null;
  };
  readonly limits: {
    readonly memory_mb: number;
    readonly pids: number;
    readonly cpu_percent: number;
    readonly cpu_ms: number;
    readonly wall_ms: number;
    readonly output_kb: number;
    readonly disk_mb: number;
  };
  readonly limits_hit: readonly LimitHit[];
  readonly hint: string | null;
  readonly isolation: {
    readonly level: number;
    readonly layers: ReceiptLayers;
    /** The Landlock ABI the payload's ruleset was built for; null when Landlock was not applied. */
    readonly landlock_abi: number | null;
  };
  /** The manifest that governed the run: the request clamped to the ceiling (contribution 4). */
  readonly manifest: ResolvedManifest;
  readonly manifest_sha256: string;
  /** SHA-256 of the policy file as read, so a receipt names the policy that clamped it. */
  readonly ceiling_sha256: string;
  readonly clamped: readonly Clamp[];
  /** Egress does not exist before Stage 5, whatever the allowlist says. */
  readonly network: { readonly mode: 'none'; readonly egress: false };
  /** Present only when the request carried a workspace or inline files (Stage 3). */
  readonly workspace?: 'overlay' | 'copy';
  readonly changes?: readonly Change[];
  readonly error?: { readonly code: string; readonly layer: string; readonly errno: string };
}

export type AblatableLayer = 'caps_dropped' | 'no_new_privs' | 'seccomp' | 'landlock';

export interface RunCellDeps {
  readonly helperPath: string;
  readonly planEnv: PlanEnv;
  /** The loaded ceiling policy. Required: there is no built-in fallback (CLAUDE.md 6.4). */
  readonly governance: { readonly ceiling: Ceiling; readonly ceilingSha256: string };
  /**
   * Test only (CLAUDE.md 6.5): hardening layers the helper must treat as unavailable. Honoured by
   * ablation builds only, and refused here unless AEGIS_TEST_UNSAFE=1 is set in the environment.
   */
  readonly ablate?: readonly AblatableLayer[];
  /** Parent directory for per-cell directories; defaults to the OS temp directory. */
  readonly tmpParent?: string;
  /** Test seams: filesystem, the engine's own /proc/self/cgroup text, uid and pid. */
  readonly cgroupFs?: CgroupFs;
  readonly selfCgroupText?: string;
  readonly uid?: number;
  readonly pid?: number;
  /** Stage 3: ingest policy, the parent for persisted workspace directories, and a test-only
   * override that skips the overlay attempt and goes straight to the copy fallback. */
  readonly ingestPolicy?: IngestPolicy;
  readonly workspaceParent?: string;
  readonly forceCopyWorkspace?: boolean;
}

interface Governed {
  readonly manifest: ResolvedManifest;
  readonly sha256: string;
  readonly ceilingSha256: string;
  readonly clamped: readonly Clamp[];
}

function limitsEcho(l: Limits): CellResult['limits'] {
  return {
    memory_mb: l.memory_mb,
    pids: l.pids,
    cpu_percent: l.cpu_percent,
    cpu_ms: l.cpu_ms,
    wall_ms: l.wall_ms,
    output_kb: l.output_kb,
    disk_mb: l.disk_mb,
  };
}

function hintLimits(l: Limits): HintLimits {
  return {
    wallMs: l.wall_ms,
    cpuMs: l.cpu_ms,
    memoryMb: l.memory_mb,
    pids: l.pids,
    outputKb: l.output_kb,
    diskMb: l.disk_mb,
  };
}

function governanceEcho(
  g: Governed,
): Pick<CellResult, 'manifest' | 'manifest_sha256' | 'ceiling_sha256' | 'clamped' | 'network'> {
  return {
    manifest: g.manifest,
    manifest_sha256: g.sha256,
    ceiling_sha256: g.ceilingSha256,
    clamped: g.clamped,
    network: { mode: 'none', egress: false },
  };
}

/** A response for a run that was refused before any payload code could start. Still a receipt. */
function refusal(
  req: RunRequest,
  g: Governed,
  layer: string,
  code: string,
  cgroupLayers: Partial<CgroupLayers> = {},
): CellResult {
  const layers = emptyReceiptLayers();
  for (const [k, v] of Object.entries(cgroupLayers)) {
    if (k in layers) layers[k as keyof typeof layers] = v;
  }
  const termination: Termination = {
    cause: 'isolation_unavailable',
    layer,
    errno: errnoNumber(code),
  };
  return {
    id: req.id,
    exit_code: null,
    stdout: '',
    stderr: '',
    termination,
    usage: { wall_ms: 0, cpu_ms: null, memory_peak_bytes: null, pids_peak: null },
    limits: limitsEcho(g.manifest.limits),
    limits_hit: [],
    hint: hintFor(termination, hintLimits(g.manifest.limits)),
    isolation: { level: isolationLevel(layers), layers, landlock_abi: null },
    ...governanceEcho(g),
    error: { code: 'isolation_unavailable', layer, errno: code },
  };
}

function readSelfCgroup(): Result<string> {
  try {
    return ok(readFileSync('/proc/self/cgroup', 'utf8'));
  } catch (e) {
    return errFromException(e, 'read /proc/self/cgroup');
  }
}

/** The bits of the required layers that the helper itself enforces before the payload runs. */
function requireMaskOf(required: readonly string[]): number {
  let mask = 0;
  for (const [name, bit] of Object.entries(REQUIRE_BITS)) {
    if (required.includes(name)) mask |= bit;
  }
  return mask;
}

/**
 * Runs one request in one cell and returns the result. Control-plane failures (cannot plan, cannot
 * create the directory, helper cannot be started) are errors; everything that happened to the
 * payload, including every refusal, is a result with a receipt.
 */
export async function runCell(req: RunRequest, deps: RunCellDeps): Promise<Result<CellResult>> {
  const plan = planUsr(deps.planEnv);
  if (!plan.ok) {
    return plan;
  }

  // 0. The manifest: what the request asked for, clamped to the ceiling, hashed. Every limit below
  // comes from the resolved values, never from the request.
  const ablate = deps.ablate ?? [];
  if (ablate.length > 0 && process.env['AEGIS_TEST_UNSAFE'] !== '1') {
    return err('EPERM', 'layer ablation is test-only and needs AEGIS_TEST_UNSAFE=1');
  }
  const ablateMask = requireMaskOf(ablate);
  const resolution = resolveManifest(req.manifest, deps.governance.ceiling);
  const gov: Governed = {
    manifest: resolution.manifest,
    sha256: resolution.sha256,
    ceilingSha256: deps.governance.ceilingSha256,
    clamped: resolution.clamped,
  };
  const lim = gov.manifest.limits;

  // 1. A cgroup for this cell, inside the subtree delegated to the user. Fail closed.
  const fs = deps.cgroupFs ?? realCgroupFs();
  const selfText = deps.selfCgroupText !== undefined ? ok(deps.selfCgroupText) : readSelfCgroup();
  if (!selfText.ok) {
    return selfText;
  }
  const uid = deps.uid ?? process.getuid?.() ?? -1;
  const delegation = locateDelegation(fs, uid, selfText.value);
  if (!delegation.ok) {
    return ok(refusal(req, gov, 'cgroup_placement', delegation.error.code));
  }
  const parent = ensureParent(fs, delegation.value.root);
  if (!parent.ok) {
    return ok(refusal(req, gov, 'cgroup_limits', parent.error.code));
  }
  const created = CellCgroup.create(
    fs,
    parent.value,
    { memoryBytes: lim.memory_mb * 1024 * 1024, pids: lim.pids, cpuPercent: lim.cpu_percent },
    deps.pid ?? process.pid,
  );
  if (!created.ok) {
    return ok(refusal(req, gov, 'cgroup_limits', created.error.code));
  }
  await using cell = created.value;
  // A manifest may require the optional cgroup layers; they are known now, before anything runs.
  for (const layer of ['cgroup_cpu', 'cgroup_kill'] as const) {
    if (gov.manifest.require.includes(layer) && !cell.layers[layer]) {
      return ok(refusal(req, gov, layer, 'ENOTSUP', cell.layers));
    }
  }

  // 2. The per-cell directory (the mountpoint of the new root) and the launch spec.
  const dirCreated = TempDir.create(
    `aegis-cell-${String(deps.pid ?? process.pid)}`,
    deps.tmpParent,
  );
  if (!dirCreated.ok) {
    return dirCreated;
  }
  using dir = dirCreated.value;
  const rootDir = dir.mkdir('root');
  if (!rootDir.ok) {
    return rootDir;
  }

  // 2b. Workspace ingest (Stage 3): a host source and/or inline files staged as the overlay's
  // lower layer. The workspace directory is deliberately NOT disposed with `dir`: it must survive
  // past this run for a later `aegis commit`/`aegis discard`.
  const needsWorkspace = req.workspaceSource !== null || req.files.length > 0;
  // overlayfs requires upperdir and workdir to be on the same mount (measured in the step 1
  // spike: separate bind mounts of two host directories give EINVAL even on the same filesystem).
  // So "upper" and "work" are subdirectories of one host directory, `rw`, bound once.
  let workspacePaths: { lower: string; rw: string; upper: string; dir: string } | null = null;
  if (needsWorkspace) {
    const wsDir = join(deps.workspaceParent ?? tmpdir(), `aegis-workspace-${req.id}`);
    try {
      mkdirSync(wsDir);
      const lowerDir = join(wsDir, 'lower');
      const rwDir = join(wsDir, 'rw');
      const upperDir = join(rwDir, 'upper');
      const workDir = join(rwDir, 'work');
      mkdirSync(lowerDir);
      mkdirSync(rwDir);
      mkdirSync(upperDir);
      mkdirSync(workDir);
      workspacePaths = { lower: lowerDir, rw: rwDir, upper: upperDir, dir: wsDir };
    } catch (e) {
      return errFromException(e, 'create workspace directory');
    }
    if (req.workspaceSource !== null) {
      const policy = deps.ingestPolicy ?? { ingestRoots: [], ingestExcludes: [] };
      const source = await resolveIngestSource(req.workspaceSource, policy, {
        fsopPath: deps.helperPath,
      });
      if (!source.ok) {
        return ok(refusal(req, gov, 'workspace_policy', source.error.code));
      }
      const rsynced = await rsyncIngest(source.value, workspacePaths.lower, policy, {
        writeExcludeFile: (content) => {
          const excludePath = join(workspacePaths?.dir ?? wsDir, 'rsync-exclude.txt');
          try {
            writeFileSync(excludePath, content);
            return Promise.resolve(ok(excludePath));
          } catch (e) {
            return Promise.resolve(errFromException(e, 'write rsync exclude file'));
          }
        },
      });
      if (!rsynced.ok) {
        return ok(refusal(req, gov, 'workspace_ingest', rsynced.error.code));
      }
    }
    if (req.files.length > 0) {
      const written = writeInlineFiles(workspacePaths.lower, req.files);
      if (!written.ok) {
        return ok(refusal(req, gov, 'workspace_files', written.error.code));
      }
    }
  }

  const env = [`PATH=${CELL_PATH}`, ...[...req.env].map(([k, v]) => `${k}=${v}`)];
  const spec: LaunchSpec = {
    argv: req.command,
    env,
    rootMountpoint: rootDir.value,
    hostname: CELL_HOSTNAME,
    rootTmpfsBytes: ROOT_TMPFS_BYTES,
    tmpTmpfsBytes: lim.disk_mb * 1024 * 1024,
    entries: plan.value,
    maskFiles: MASK_FILES,
    maskDirs: MASK_DIRS,
    cgroupFd: true,
    requireMask: requireMaskOf(gov.manifest.require),
    ...(ablateMask !== 0 ? { ablateMask } : {}),
    ...(workspacePaths !== null
      ? {
          workspace: planWorkspace(
            { lower: workspacePaths.lower, rw: workspacePaths.rw },
            deps.forceCopyWorkspace ?? false,
          ),
        }
      : {}),
  };
  const encoded = encodeLaunchSpec(spec);
  if (!encoded.ok) {
    return encoded;
  }

  // 3. Run, watching the kernel counters the receipt will quote.
  const cpuBudgetUs = lim.cpu_ms * 1000;
  // The host-backed upper layer is not a size-capped tmpfs, so it is capped here by polling:
  // `disk_mb` bounds what the program may change in the workspace, same as it bounds /tmp. The
  // overshoot is at most what can be written in one poll interval.
  const upperCapBytes = lim.disk_mb * 1024 * 1024;
  const upperDir = workspacePaths?.upper ?? null;
  const poll = (): PollVerdict | null => {
    if (cell.pidsMaxHits() > 0) return { kind: 'pids_limit' };
    if (cell.cpuUsageUs() > cpuBudgetUs) return { kind: 'timeout', clock: 'cpu' };
    if (upperDir !== null && treeBytes(upperDir, upperCapBytes) > upperCapBytes) {
      return { kind: 'disk_limit', path: '/workspace' };
    }
    return null;
  };
  const ran = await superviseCell({
    helper: deps.helperPath,
    spec: encoded.value,
    wallMs: lim.wall_ms,
    maxOutputBytes: lim.output_kb * 1024,
    cgroupFd: cell.dirFd.fd,
    poll,
    killCell: () => {
      cell.kill();
    },
  });
  if (!ran.ok) {
    return ran;
  }
  const o = ran.value;

  // 4. Teardown: nothing may survive the run. Wait for populated 0 before reading the counters.
  let stuck = false;
  if (!(await cell.waitEmpty(EMPTY_WAIT_MS))) {
    cell.kill();
    stuck = !(await cell.waitEmpty(EMPTY_WAIT_MS));
  }
  const stats = cell.stats();

  const parsed = parseStatus(o.status);
  if (!parsed.ok) {
    return err('EPROTO', `helper status: ${parsed.error.context}`);
  }
  const records = parsed.value;

  const layers = emptyReceiptLayers();
  for (const r of records) {
    if (r.kind === 'layer' && r.ok && (HELPER_LAYERS as readonly string[]).includes(r.layer)) {
      layers[r.layer as keyof typeof layers] = true;
    }
  }
  layers.cgroup_memory = cell.layers.cgroup_memory;
  layers.cgroup_pids = cell.layers.cgroup_pids;
  layers.cgroup_cpu = cell.layers.cgroup_cpu;
  layers.cgroup_kill = cell.layers.cgroup_kill;
  const abiRecord = records.find((r) => r.kind === 'landlock_abi');
  const landlockAbi = layers.landlock && abiRecord?.kind === 'landlock_abi' ? abiRecord.abi : null;

  let workspaceMode: 'overlay' | 'copy' | null = null;
  let changes: Change[] = [];
  if (workspacePaths !== null) {
    const wsRecord = records.find((r) => r.kind === 'workspace');
    workspaceMode = wsRecord?.kind === 'workspace' ? wsRecord.mode : null;
    if (workspaceMode !== null) {
      const d =
        workspaceMode === 'overlay'
          ? diffOverlayUpper(workspacePaths.lower, workspacePaths.upper)
          : diffCopyResult(workspacePaths.lower, workspacePaths.upper);
      if (d.ok) {
        changes = d.value;
        try {
          writeFileSync(
            join(workspacePaths.dir, 'changes.json'),
            JSON.stringify({
              mode: workspaceMode,
              upper: workspacePaths.upper,
              lower: workspacePaths.lower,
              changes,
            }),
          );
        } catch {
          // Best effort: a later `aegis commit` finds nothing recorded and reports that, rather
          // than this already-complete run result failing over a bookkeeping write.
        }
      }
    }
  }

  const c = classify({
    records,
    supervisorKill: o.killedFor,
    oomKills: stats.oomKills,
    pidsMaxHits: stats.pidsMaxHits,
  });
  let termination: Termination = stuck ? { cause: 'internal_error' } : c.termination;

  // Second, independent check of the manifest's required layers, from the receipt (the helper made
  // the first one before it ran the payload). A payload that ran without one is an engine bug: the
  // output is withheld rather than presented as the result of a compliant run.
  // Only a payload that actually started can have violated it; a cell that was killed or failed
  // before `started` never ran anything, and its own termination already says why.
  const missing = gov.manifest.require.find((l) => !layers[l]);
  const violated = missing !== undefined && records.some((r) => r.kind === 'started') && !stuck;
  if (violated) {
    termination = { cause: 'isolation_unavailable', layer: missing, errno: errnoNumber('EPROTO') };
  }

  const base = {
    id: req.id,
    exit_code: violated ? null : c.exitCode,
    stdout: violated ? '' : o.stdout.toString('utf8'),
    stderr: violated ? '' : o.stderr.toString('utf8'),
    termination,
    usage: {
      wall_ms: o.wallMs,
      cpu_ms: Math.round(stats.cpuUsageUs / 1000),
      memory_peak_bytes: stats.memoryPeakBytes,
      pids_peak: stats.pidsPeak,
    },
    limits: limitsEcho(lim),
    limits_hit: c.limitsHit,
    hint: stuck
      ? 'the cell did not empty after the kill; it was left for the reaper'
      : hintFor(termination, hintLimits(lim)),
    isolation: { level: isolationLevel(layers), layers, landlock_abi: landlockAbi },
    ...governanceEcho(gov),
    ...(workspacePaths !== null ? { workspace: workspaceMode ?? 'copy', changes } : {}),
  };
  if (termination.cause === 'isolation_unavailable') {
    return ok({
      ...base,
      error: {
        code: 'isolation_unavailable',
        layer: termination.layer,
        errno: errnoName(termination.errno),
      },
    });
  }
  return ok(base);
}
