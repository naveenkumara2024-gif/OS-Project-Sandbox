import { classify, errnoName, type Termination } from '../collect/classify.js';
import type { RunRequest } from '../gateway/request.js';
import { superviseCell } from '../supervise/cell-supervisor.js';
import { encodeLaunchSpec, type LaunchSpec } from '../sys/launch-spec.js';
import { parseStatus, RECEIPT_LAYERS, type ReceiptLayer } from '../sys/status.js';
import { TempDir } from '../util/tempdir.js';
import { err, ok, type Result } from '../util/result.js';
import { planUsr, type PlanEnv } from './rootfs-plan.js';

/** Fixed, not caller-controlled (CLAUDE.md 6.1 item 5); the request may add other names. */
export const CELL_PATH = '/usr/bin:/bin';
export const CELL_HOSTNAME = 'aegis';
export const ROOT_TMPFS_BYTES = 64 * 1024 * 1024;
export const TMP_TMPFS_BYTES = 16 * 1024 * 1024;

// Best-effort: do not offer the control plane's own runtime inside a cell (CLAUDE.md 6.1 item 2).
// The native side only masks what exists. This is not a security boundary (prompt section 4.9).
const MASK_FILES = ['/usr/bin/node', '/usr/bin/nodejs'];
const MASK_DIRS = ['/usr/include/node', '/usr/lib/node_modules'];

export interface CellResult {
  readonly id: string;
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly termination: Termination;
  readonly usage: { readonly wall_ms: number };
  readonly isolation: { readonly layers: Readonly<Record<ReceiptLayer, boolean>> };
  readonly error?: { readonly code: string; readonly layer: string; readonly errno: string };
}

export interface RunCellDeps {
  readonly helperPath: string;
  readonly planEnv: PlanEnv;
  /** Parent directory for the per-cell directory; defaults to the OS temp directory. */
  readonly tmpParent?: string;
}

function emptyLayers(): Record<ReceiptLayer, boolean> {
  const o = {} as Record<ReceiptLayer, boolean>;
  for (const l of RECEIPT_LAYERS) o[l] = false;
  return o;
}

/**
 * Runs one request in one cell and returns the result. Control-plane failures (cannot plan, cannot
 * create the directory, helper cannot be started) are errors; everything that happened to the
 * payload, including isolation_unavailable, is a result.
 */
export async function runCell(req: RunRequest, deps: RunCellDeps): Promise<Result<CellResult>> {
  const plan = planUsr(deps.planEnv);
  if (!plan.ok) {
    return plan;
  }

  const created = TempDir.create('aegis-cell', deps.tmpParent);
  if (!created.ok) {
    return created;
  }
  using dir = created.value;
  const rootDir = dir.mkdir('root');
  if (!rootDir.ok) {
    return rootDir;
  }

  const env = [`PATH=${CELL_PATH}`, ...[...req.env].map(([k, v]) => `${k}=${v}`)];
  const spec: LaunchSpec = {
    argv: req.command,
    env,
    rootMountpoint: rootDir.value,
    hostname: CELL_HOSTNAME,
    rootTmpfsBytes: ROOT_TMPFS_BYTES,
    tmpTmpfsBytes: TMP_TMPFS_BYTES,
    entries: plan.value,
    maskFiles: MASK_FILES,
    maskDirs: MASK_DIRS,
  };
  const encoded = encodeLaunchSpec(spec);
  if (!encoded.ok) {
    return encoded;
  }

  const ran = await superviseCell({
    helper: deps.helperPath,
    spec: encoded.value,
    wallMs: req.wallMs,
    maxOutputBytes: req.outputBytes,
  });
  if (!ran.ok) {
    return ran;
  }
  const o = ran.value;

  const parsed = parseStatus(o.status);
  if (!parsed.ok) {
    return err('EPROTO', `helper status: ${parsed.error.context}`);
  }
  const records = parsed.value;

  const layers = emptyLayers();
  for (const r of records) {
    if (r.kind === 'layer' && r.ok && (RECEIPT_LAYERS as readonly string[]).includes(r.layer)) {
      layers[r.layer as ReceiptLayer] = true;
    }
  }

  const c = classify({ records, timedOut: o.timedOut, outputLimit: o.outputLimit });
  const base = {
    id: req.id,
    exit_code: c.exitCode,
    stdout: o.stdout.toString('utf8'),
    stderr: o.stderr.toString('utf8'),
    termination: c.termination,
    usage: { wall_ms: o.wallMs },
    isolation: { layers },
  };
  if (c.termination.cause === 'isolation_unavailable') {
    return ok({
      ...base,
      error: {
        code: 'isolation_unavailable',
        layer: c.termination.layer,
        errno: errnoName(c.termination.errno),
      },
    });
  }
  return ok(base);
}
