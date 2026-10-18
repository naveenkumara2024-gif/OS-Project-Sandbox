import { randomBytes } from 'node:crypto';
import {
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parseControllerList, parseSelfCgroup } from '../probe/procfs.js';
import { OwnedFd } from '../util/fd.js';
import { err, errFromException, ok, okVoid, type Result } from '../util/result.js';

// cgroup v2 placement for cells (docs/prompts/stage-2-limits-and-receipts.md section 4).
//
// The engine finds the cgroup it runs in, walks up while the directories are owned by the user (a
// delegated subtree), and creates a process-free parent `aegis-cells` there: cgroup v2 forbids
// enabling controllers on a group that holds processes, and Node itself is one. Each cell is a leaf
// below it. All limits are written and read back; a value that does not read back equal makes the
// layer false.

export const CGROUP_MOUNT = '/sys/fs/cgroup';
const PARENT_NAME = 'aegis-cells';
const CPU_PERIOD_US = 100_000;

/** The filesystem operations cgroup management needs; tests inject a fake. */
export interface CgroupFs {
  readText(path: string): Result<string>;
  writeText(path: string, data: string): Result<void>;
  /** Creates one directory; an existing one is not an error. */
  mkdir(path: string): Result<void>;
  rmdir(path: string): Result<void>;
  ownerUid(path: string): Result<number>;
  exists(path: string): boolean;
  list(path: string): Result<string[]>;
  openDir(path: string): Result<OwnedFd>;
}

export function realCgroupFs(): CgroupFs {
  return {
    readText(path) {
      try {
        return ok(readFileSync(path, 'utf8'));
      } catch (e) {
        return errFromException(e, `read ${path}`);
      }
    },
    writeText(path, data) {
      try {
        writeFileSync(path, data);
        return okVoid;
      } catch (e) {
        return errFromException(e, `write ${path}`);
      }
    },
    mkdir(path) {
      try {
        mkdirSync(path, { mode: 0o755 });
        return okVoid;
      } catch (e) {
        if (typeof e === 'object' && e !== null && Reflect.get(e, 'code') === 'EEXIST') {
          return okVoid;
        }
        return errFromException(e, `mkdir ${path}`);
      }
    },
    rmdir(path) {
      try {
        rmdirSync(path);
        return okVoid;
      } catch (e) {
        return errFromException(e, `rmdir ${path}`);
      }
    },
    ownerUid(path) {
      try {
        return ok(statSync(path).uid);
      } catch (e) {
        return errFromException(e, `stat ${path}`);
      }
    },
    exists: (path) => existsSync(path),
    list(path) {
      try {
        return ok(readdirSync(path));
      } catch (e) {
        return errFromException(e, `readdir ${path}`);
      }
    },
    openDir(path) {
      try {
        const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
        return ok(OwnedFd.adopt(fd));
      } catch (e) {
        return errFromException(e, `open ${path}`);
      }
    },
  };
}

/** Parses `key value` lines such as memory.events, pids.events and cpu.stat. */
export function parseKeyed(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length === 2 && f[0] !== undefined && f[1] !== undefined && /^\d{1,18}$/.test(f[1])) {
      m.set(f[0], Number(f[1]));
    }
  }
  return m;
}

function parseOneInt(text: string): number | null {
  const t = text.trim();
  return /^\d{1,18}$/.test(t) ? Number(t) : null;
}

export interface Delegation {
  /** Absolute directory of the highest cgroup in the chain that the user owns. */
  readonly root: string;
  /** Absolute directory of the engine's own cgroup. */
  readonly self: string;
}

/**
 * Finds the delegated subtree the engine runs in. Fails closed (EACCES) when the engine's own
 * cgroup is not owned by the user, which is what a plain `wsl.exe` shell (`/init.scope`) looks like.
 */
export function locateDelegation(
  fs: CgroupFs,
  uid: number,
  selfCgroupText: string,
  mount: string = CGROUP_MOUNT,
): Result<Delegation> {
  const v2 = parseSelfCgroup(selfCgroupText).v2Path;
  if (v2 === null) {
    return err('ENOTSUP', 'cgroup v2 is not the unified hierarchy for this process');
  }
  const self = join(mount, v2);
  const owner = fs.ownerUid(self);
  if (!owner.ok) {
    return owner;
  }
  if (owner.value !== uid) {
    return err('EACCES', `engine cgroup ${v2} is not delegated to this user`);
  }
  let dir = self;
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir || parent.length < mount.length) {
      break;
    }
    const o = fs.ownerUid(parent);
    if (!o.ok || o.value !== uid) {
      break;
    }
    dir = parent;
  }
  return ok({ root: dir, self });
}

export interface CellParent {
  readonly path: string;
  readonly controllers: { readonly memory: boolean; readonly pids: boolean; readonly cpu: boolean };
}

/** Creates `<root>/aegis-cells` once and enables the controllers cells need. Idempotent. */
export function ensureParent(fs: CgroupFs, root: string): Result<CellParent> {
  const path = join(root, PARENT_NAME);
  const made = fs.mkdir(path);
  if (!made.ok) {
    return made;
  }
  const avail = fs.readText(join(path, 'cgroup.controllers'));
  if (!avail.ok) {
    return avail;
  }
  const have = new Set(parseControllerList(avail.value));
  if (!have.has('memory') || !have.has('pids')) {
    return err('ENOTSUP', 'the memory and pids controllers are not delegated to this subtree');
  }
  const want = ['memory', 'pids', ...(have.has('cpu') ? ['cpu'] : [])];
  const enabled = fs.writeText(
    join(path, 'cgroup.subtree_control'),
    want.map((c) => `+${c}`).join(' '),
  );
  if (!enabled.ok) {
    return enabled;
  }
  return ok({
    path,
    controllers: { memory: true, pids: true, cpu: have.has('cpu') },
  });
}

export interface CellLimits {
  readonly memoryBytes: number;
  readonly pids: number;
  /** Percent of one CPU, 1 to 400. */
  readonly cpuPercent: number;
}

export interface CgroupLayers {
  readonly cgroup_memory: boolean;
  readonly cgroup_pids: boolean;
  readonly cgroup_cpu: boolean;
  readonly cgroup_kill: boolean;
}

export interface CellStats {
  readonly memoryPeakBytes: number | null;
  readonly oomKills: number;
  readonly pidsPeak: number | null;
  readonly pidsMaxHits: number;
  readonly cpuUsageUs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One cell's cgroup. Removal is `rmdir` of an empty group only; never forced. */
export class CellCgroup implements AsyncDisposable {
  readonly path: string;
  readonly layers: CgroupLayers;
  /** Directory descriptor to hand to the helper for CLONE_INTO_CGROUP. */
  readonly dirFd: OwnedFd;
  readonly #fs: CgroupFs;
  #leaked = false;
  #disposed = false;

  private constructor(fs: CgroupFs, path: string, layers: CgroupLayers, dirFd: OwnedFd) {
    this.#fs = fs;
    this.path = path;
    this.layers = layers;
    this.dirFd = dirFd;
  }

  /** Creates the group, writes every limit and reads it back. */
  static create(
    fs: CgroupFs,
    parent: CellParent,
    limits: CellLimits,
    pid: number,
  ): Result<CellCgroup> {
    const name = `cell-${String(pid)}-${randomBytes(4).toString('hex')}`;
    const path = join(parent.path, name);
    const made = fs.mkdir(path);
    if (!made.ok) {
      return made;
    }
    const fail = (e: Result<never>): Result<never> => {
      fs.rmdir(path);
      return e;
    };

    const setAndVerify = (file: string, value: string): boolean => {
      const target = join(path, file);
      if (!fs.writeText(target, value).ok) return false;
      const back = fs.readText(target);
      return back.ok && back.value.trim() === value;
    };

    const memoryOk =
      setAndVerify('memory.max', String(limits.memoryBytes)) &&
      setAndVerify('memory.swap.max', '0') &&
      setAndVerify('memory.oom.group', '1');
    const pidsOk = setAndVerify('pids.max', String(limits.pids));
    const quota = Math.round(limits.cpuPercent * (CPU_PERIOD_US / 100));
    const cpuOk =
      parent.controllers.cpu &&
      setAndVerify('cpu.max', `${String(quota)} ${String(CPU_PERIOD_US)}`);
    const killOk = fs.exists(join(path, 'cgroup.kill'));

    if (!memoryOk || !pidsOk) {
      return fail(
        err(
          'EIO',
          `cgroup limits did not read back (memory ${String(memoryOk)}, pids ${String(pidsOk)})`,
        ),
      );
    }
    const fd = fs.openDir(path);
    if (!fd.ok) {
      return fail(fd);
    }
    return ok(
      new CellCgroup(
        fs,
        path,
        {
          cgroup_memory: memoryOk,
          cgroup_pids: pidsOk,
          cgroup_cpu: cpuOk,
          cgroup_kill: killOk,
        },
        fd.value,
      ),
    );
  }

  get leaked(): boolean {
    return this.#leaked;
  }

  #readKeyed(file: string): Map<string, number> {
    const t = this.#fs.readText(join(this.path, file));
    return t.ok ? parseKeyed(t.value) : new Map<string, number>();
  }

  #readInt(file: string): number | null {
    const t = this.#fs.readText(join(this.path, file));
    return t.ok ? parseOneInt(t.value) : null;
  }

  pidsMaxHits(): number {
    return this.#readKeyed('pids.events').get('max') ?? 0;
  }

  oomKills(): number {
    return this.#readKeyed('memory.events').get('oom_kill') ?? 0;
  }

  cpuUsageUs(): number {
    return this.#readKeyed('cpu.stat').get('usage_usec') ?? 0;
  }

  /** Memory in use right now, for limit warnings; null when the file is unreadable. */
  memoryCurrentBytes(): number | null {
    return this.#readInt('memory.current');
  }

  pidsCurrent(): number | null {
    return this.#readInt('pids.current');
  }

  isPopulated(): boolean {
    const t = this.#fs.readText(join(this.path, 'cgroup.events'));
    if (!t.ok) return false;
    return parseKeyed(t.value).get('populated') === 1;
  }

  /** Kills every process in the cell. `cgroup.kill` when present, per-pid SIGKILL otherwise. */
  kill(): void {
    if (this.layers.cgroup_kill) {
      this.#fs.writeText(join(this.path, 'cgroup.kill'), '1');
      return;
    }
    const procs = this.#fs.readText(join(this.path, 'cgroup.procs'));
    if (!procs.ok) return;
    for (const p of procs.value.split('\n')) {
      const n = Number(p);
      if (Number.isInteger(n) && n > 1) {
        try {
          process.kill(n, 'SIGKILL');
        } catch {
          // The process may already be gone; the wait below is the authority.
        }
      }
    }
  }

  /** Resolves true once `populated 0` was observed. */
  async waitEmpty(timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (!this.isPopulated()) return true;
      if (performance.now() >= deadline) return false;
      await sleep(5);
    }
  }

  stats(): CellStats {
    return {
      memoryPeakBytes: this.#readInt('memory.peak'),
      oomKills: this.oomKills(),
      pidsPeak: this.#readInt('pids.peak'),
      pidsMaxHits: this.pidsMaxHits(),
      cpuUsageUs: this.cpuUsageUs(),
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.dirFd.close();
    if (this.isPopulated()) {
      this.kill();
      if (!(await this.waitEmpty(5000))) {
        this.#leaked = true;
        return;
      }
    }
    const r = this.#fs.rmdir(this.path);
    if (!r.ok) {
      this.#leaked = true;
    }
  }
}

export interface ReapResult {
  readonly removed: number;
  readonly skippedLive: number;
  readonly stuck: number;
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return typeof e === 'object' && e !== null && Reflect.get(e, 'code') === 'EPERM';
  }
}

/**
 * Removes cell cgroups left by dead engine processes (`cell-<pid>-*`). A live pid is never
 * touched, and a group that will not empty is reported, not forced.
 */
export async function reapOrphanCells(
  fs: CgroupFs,
  parentPath: string,
  isAlive: (pid: number) => boolean = pidIsAlive,
): Promise<ReapResult> {
  let removed = 0;
  let skippedLive = 0;
  let stuck = 0;
  const names = fs.list(parentPath);
  if (!names.ok) {
    return { removed, skippedLive, stuck };
  }
  for (const name of names.value) {
    const m = /^cell-(\d+)-[0-9a-f]+$/.exec(name);
    const pidText = m?.[1];
    if (pidText === undefined) continue;
    if (isAlive(Number(pidText))) {
      skippedLive += 1;
      continue;
    }
    const dir = join(parentPath, name);
    fs.writeText(join(dir, 'cgroup.kill'), '1');
    let empty = false;
    for (let i = 0; i < 400; i++) {
      const ev = fs.readText(join(dir, 'cgroup.events'));
      if (!ev.ok || parseKeyed(ev.value).get('populated') !== 1) {
        empty = true;
        break;
      }
      await sleep(5);
    }
    if (empty && fs.rmdir(dir).ok) {
      removed += 1;
    } else {
      stuck += 1;
    }
  }
  return { removed, skippedLive, stuck };
}
