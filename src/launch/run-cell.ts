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
import { diffCopyResult, diffOverlayUpper, type Change } from '../collect/diff.js';
import {
  resolveIngestSource,
  rsyncIngest,
  writeInlineFiles,
  type IngestPolicy,
} from '../stage/ingest.js';
import { planWorkspace } from './workspace-plan.js';
import { emptyReceiptLayers, isolationLevel, type ReceiptLayers } from '../probe/isolation.js';
import { superviseCell, type PollVerdict } from '../supervise/cell-supervisor.js';
import { encodeLaunchSpec, type LaunchSpec } from '../sys/launch-spec.js';
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
  readonly isolation: { readonly level: number; readonly layers: ReceiptLayers };
  /** Present only when the request carried a workspace or inline files (Stage 3). */
  readonly workspace?: 'overlay' | 'copy';
  readonly changes?: readonly Change[];
  readonly error?: { readonly code: string; readonly layer: string; readonly errno: string };
}

export interface RunCellDeps {
  readonly helperPath: string;
  readonly planEnv: PlanEnv;
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

function limitsEcho(req: RunRequest): CellResult['limits'] {
  return {
    memory_mb: req.memoryMb,
    pids: req.pids,
    cpu_percent: req.cpuPercent,
    cpu_ms: req.cpuMs,
    wall_ms: req.wallMs,
    output_kb: req.outputBytes / 1024,
    disk_mb: req.diskMb,
  };
}

function hintLimits(req: RunRequest): HintLimits {
  return {
    wallMs: req.wallMs,
    cpuMs: req.cpuMs,
    memoryMb: req.memoryMb,
    pids: req.pids,
    outputKb: req.outputBytes / 1024,
    diskMb: req.diskMb,
  };
}

/** A response for a run that was refused before any payload code could start. Still a receipt. */
function refusal(
  req: RunRequest,
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
    limits: limitsEcho(req),
    limits_hit: [],
    hint: hintFor(termination, hintLimits(req)),
    isolation: { level: isolationLevel(layers), layers },
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

  // 1. A cgroup for this cell, inside the subtree delegated to the user. Fail closed.
  const fs = deps.cgroupFs ?? realCgroupFs();
  const selfText = deps.selfCgroupText !== undefined ? ok(deps.selfCgroupText) : readSelfCgroup();
  if (!selfText.ok) {
    return selfText;
  }
  const uid = deps.uid ?? process.getuid?.() ?? -1;
  const delegation = locateDelegation(fs, uid, selfText.value);
  if (!delegation.ok) {
    return ok(refusal(req, 'cgroup_placement', delegation.error.code));
  }
  const parent = ensureParent(fs, delegation.value.root);
  if (!parent.ok) {
    return ok(refusal(req, 'cgroup_limits', parent.error.code));
  }
  const created = CellCgroup.create(
    fs,
    parent.value,
    { memoryBytes: req.memoryMb * 1024 * 1024, pids: req.pids, cpuPercent: req.cpuPercent },
    deps.pid ?? process.pid,
  );
  if (!created.ok) {
    return ok(refusal(req, 'cgroup_limits', created.error.code));
  }
  await using cell = created.value;

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
        return ok(refusal(req, 'workspace_policy', source.error.code));
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
        return ok(refusal(req, 'workspace_ingest', rsynced.error.code));
      }
    }
    if (req.files.length > 0) {
      const written = writeInlineFiles(workspacePaths.lower, req.files);
      if (!written.ok) {
        return ok(refusal(req, 'workspace_files', written.error.code));
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
    tmpTmpfsBytes: req.diskMb * 1024 * 1024,
    entries: plan.value,
    maskFiles: MASK_FILES,
    maskDirs: MASK_DIRS,
    cgroupFd: true,
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
  const cpuBudgetUs = req.cpuMs * 1000;
  const poll = (): PollVerdict | null => {
    if (cell.pidsMaxHits() > 0) return { kind: 'pids_limit' };
    if (cell.cpuUsageUs() > cpuBudgetUs) return { kind: 'timeout', clock: 'cpu' };
    return null;
  };
  const ran = await superviseCell({
    helper: deps.helperPath,
    spec: encoded.value,
    wallMs: req.wallMs,
    maxOutputBytes: req.outputBytes,
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
  const termination: Termination = stuck ? { cause: 'internal_error' } : c.termination;

  const base = {
    id: req.id,
    exit_code: c.exitCode,
    stdout: o.stdout.toString('utf8'),
    stderr: o.stderr.toString('utf8'),
    termination,
    usage: {
      wall_ms: o.wallMs,
      cpu_ms: Math.round(stats.cpuUsageUs / 1000),
      memory_peak_bytes: stats.memoryPeakBytes,
      pids_peak: stats.pidsPeak,
    },
    limits: limitsEcho(req),
    limits_hit: c.limitsHit,
    hint: stuck
      ? 'the cell did not empty after the kill; it was left for the reaper'
      : hintFor(termination, hintLimits(req)),
    isolation: { level: isolationLevel(layers), layers },
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
