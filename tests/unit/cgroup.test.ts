import { openSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CellCgroup,
  ensureParent,
  locateDelegation,
  parseKeyed,
  reapOrphanCells,
  type CgroupFs,
  type CellParent,
} from '../../src/launch/cgroup.js';
import { OwnedFd } from '../../src/util/fd.js';
import { err, ok, okVoid } from '../../src/util/result.js';

/** An in-memory cgroup tree: files, directories and owners. */
class FakeFs implements CgroupFs {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  readonly owners = new Map<string, number>();
  readonly writes: [string, string][] = [];
  /** Paths whose writes are silently ignored, to simulate a limit that does not read back. */
  readonly ignoreWrites = new Set<string>();
  readonly failWrites = new Set<string>();

  readText(path: string) {
    const v = this.files.get(path);
    return v === undefined ? err('ENOENT', path) : ok(v);
  }
  writeText(path: string, data: string) {
    this.writes.push([path, data]);
    if (this.failWrites.has(path)) return err('EACCES', path);
    if (!this.ignoreWrites.has(path)) this.files.set(path, `${data}\n`);
    return okVoid;
  }
  mkdir(path: string) {
    this.dirs.add(path);
    return okVoid;
  }
  rmdir(path: string) {
    if (!this.dirs.delete(path)) return err('ENOENT', path);
    return okVoid;
  }
  ownerUid(path: string) {
    const o = this.owners.get(path);
    return o === undefined ? err('ENOENT', path) : ok(o);
  }
  exists(path: string) {
    return this.files.has(path) || this.dirs.has(path);
  }
  list(path: string) {
    const prefix = `${path}/`;
    const names = [...this.dirs]
      .filter((d) => d.startsWith(prefix) && !d.slice(prefix.length).includes('/'))
      .map((d) => d.slice(prefix.length));
    return ok(names);
  }
  openDir() {
    return ok(OwnedFd.adopt(openSync('/dev/null', 'r')));
  }
}

const MOUNT = '/sys/fs/cgroup';
const ROOT = `${MOUNT}/user.slice/user-1000.slice/user@1000.service`;
const SELF = `${ROOT}/app.slice/run-1.scope`;

function delegatedFs(): FakeFs {
  const fs = new FakeFs();
  for (const p of [SELF, `${ROOT}/app.slice`, ROOT]) fs.owners.set(p, 1000);
  fs.owners.set(`${MOUNT}/user.slice/user-1000.slice`, 0);
  fs.owners.set(`${MOUNT}/user.slice`, 0);
  fs.owners.set(`${MOUNT}/init.scope`, 0);
  return fs;
}

describe('locateDelegation', () => {
  it('finds the highest cgroup the user owns', () => {
    const r = locateDelegation(delegatedFs(), 1000, `0::${SELF.slice(MOUNT.length)}\n`, MOUNT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.root).toBe(ROOT);
      expect(r.value.self).toBe(SELF);
    }
  });

  it('refuses when the engine sits outside any delegated subtree', () => {
    const r = locateDelegation(delegatedFs(), 1000, '0::/init.scope\n', MOUNT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('EACCES');
  });

  it('refuses without the unified hierarchy', () => {
    const r = locateDelegation(delegatedFs(), 1000, '12:memory:/foo\n', MOUNT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ENOTSUP');
  });

  it('refuses when the cgroup directory does not exist', () => {
    const r = locateDelegation(delegatedFs(), 1000, '0::/nope\n', MOUNT);
    expect(r.ok).toBe(false);
  });
});

describe('ensureParent', () => {
  it('creates the parent and enables exactly the delegated controllers', () => {
    const fs = delegatedFs();
    fs.files.set(`${ROOT}/aegis-cells/cgroup.controllers`, 'cpu memory pids\n');
    const r = ensureParent(fs, ROOT);
    expect(r.ok && r.value.controllers).toEqual({ memory: true, pids: true, cpu: true });
    expect(fs.writes).toContainEqual([
      `${ROOT}/aegis-cells/cgroup.subtree_control`,
      '+memory +pids +cpu',
    ]);
  });

  it('works without cpu, and reports it', () => {
    const fs = delegatedFs();
    fs.files.set(`${ROOT}/aegis-cells/cgroup.controllers`, 'memory pids\n');
    const r = ensureParent(fs, ROOT);
    expect(r.ok && r.value.controllers.cpu).toBe(false);
    expect(fs.writes).toContainEqual([
      `${ROOT}/aegis-cells/cgroup.subtree_control`,
      '+memory +pids',
    ]);
  });

  it('refuses without memory or pids', () => {
    const fs = delegatedFs();
    fs.files.set(`${ROOT}/aegis-cells/cgroup.controllers`, 'cpu pids\n');
    expect(ensureParent(fs, ROOT).ok).toBe(false);
  });
});

describe('CellCgroup.create', () => {
  const parent: CellParent = {
    path: `${ROOT}/aegis-cells`,
    controllers: { memory: true, pids: true, cpu: true },
  };
  const limits = { memoryBytes: 512 * 1024 * 1024, pids: 128, cpuPercent: 50 };

  it('writes every limit, reads it back and reports the layers', () => {
    const fs = delegatedFs();
    const r = CellCgroup.create(fs, parent, limits, 4242);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.path).toMatch(/aegis-cells\/cell-4242-[0-9a-f]{8}$/);
    const w = new Map(fs.writes.map(([p, d]) => [p.slice(r.value.path.length + 1), d]));
    expect(w.get('memory.max')).toBe(String(512 * 1024 * 1024));
    expect(w.get('memory.swap.max')).toBe('0');
    expect(w.get('memory.oom.group')).toBe('1');
    expect(w.get('pids.max')).toBe('128');
    expect(w.get('cpu.max')).toBe('50000 100000');
    expect(r.value.layers).toEqual({
      cgroup_memory: true,
      cgroup_pids: true,
      cgroup_cpu: true,
      cgroup_kill: false, // the fake has no cgroup.kill file
    });
    r.value.dirFd.close();
  });

  it('fails closed, and removes the group, when a limit does not read back', () => {
    const fs = delegatedFs();
    // memory.max writes are swallowed, so the read-back finds nothing equal to the request.
    const name = 'cell-1-';
    const original = fs.mkdir.bind(fs);
    fs.mkdir = (p: string) => {
      if (p.includes(name)) fs.ignoreWrites.add(`${p}/memory.max`);
      return original(p);
    };
    const r = CellCgroup.create(fs, parent, limits, 1);
    expect(r.ok).toBe(false);
    expect([...fs.dirs].some((d) => d.includes('cell-1-'))).toBe(false);
  });

  it('reports cgroup_cpu false when cpu is not delegated, without failing', () => {
    const fs = delegatedFs();
    const r = CellCgroup.create(
      fs,
      { ...parent, controllers: { memory: true, pids: true, cpu: false } },
      limits,
      7,
    );
    expect(r.ok && r.value.layers.cgroup_cpu).toBe(false);
    if (r.ok) r.value.dirFd.close();
  });
});

describe('reapOrphanCells', () => {
  it('removes dead pids, leaves live ones, ignores unrelated names', async () => {
    const fs = delegatedFs();
    const parent = `${ROOT}/aegis-cells`;
    for (const n of ['cell-111-aabbccdd', 'cell-222-11223344', 'not-a-cell', 'cell-x-1']) {
      fs.dirs.add(`${parent}/${n}`);
      fs.files.set(`${parent}/${n}/cgroup.events`, 'populated 0\nfrozen 0\n');
    }
    const r = await reapOrphanCells(fs, parent, (pid) => pid === 222);
    expect(r).toEqual({ removed: 1, skippedLive: 1, stuck: 0 });
    expect(fs.dirs.has(`${parent}/cell-111-aabbccdd`)).toBe(false);
    expect(fs.dirs.has(`${parent}/cell-222-11223344`)).toBe(true);
    expect(fs.writes).toContainEqual([`${parent}/cell-111-aabbccdd/cgroup.kill`, '1']);
    expect(fs.writes.some(([p]) => p.includes('cell-222'))).toBe(false);
  });

  it('reports a group that will not empty instead of forcing it', async () => {
    const fs = delegatedFs();
    const parent = `${ROOT}/aegis-cells`;
    fs.dirs.add(`${parent}/cell-9-aaaaaaaa`);
    fs.files.set(`${parent}/cell-9-aaaaaaaa/cgroup.events`, 'populated 1\n');
    const r = await reapOrphanCells(fs, parent, () => false);
    expect(r.stuck).toBe(1);
    expect(fs.dirs.has(`${parent}/cell-9-aaaaaaaa`)).toBe(true);
  });
});

describe('parseKeyed', () => {
  it('parses key value lines and skips junk', () => {
    const m = parseKeyed('low 0\nmax 3\noom_kill 1\ngarbage\nx y\n');
    expect(m.get('max')).toBe(3);
    expect(m.get('oom_kill')).toBe(1);
    expect(m.has('garbage')).toBe(false);
    expect(m.has('x')).toBe(false);
  });
});
