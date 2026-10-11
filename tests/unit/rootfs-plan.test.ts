import { describe, expect, it } from 'vitest';
import { planUsr, type DirItem, type PlanEnv } from '../../src/launch/rootfs-plan.js';
import { err, ok } from '../../src/util/result.js';

function mountinfo(points: string[]): string {
  return points
    .map((p, i) => `${String(30 + i)} 1 0:${String(i)} / ${p} rw - ext4 /dev/sde rw`)
    .join('\n');
}

function env(
  points: string[],
  tree: Record<string, DirItem[]>,
  links: Record<string, string> = {},
): PlanEnv {
  return {
    readMountInfo: () => ok(mountinfo(points)),
    listDir: (p) => {
      const t = tree[p];
      return t === undefined ? err('ENOENT', p) : ok(t);
    },
    readLink: (p) => {
      const l = links[p];
      return l === undefined ? err('ENOENT', p) : ok(l);
    },
  };
}

const d = (name: string): DirItem => ({ name, kind: 'dir' });
const f = (name: string): DirItem => ({ name, kind: 'file' });
const l = (name: string): DirItem => ({ name, kind: 'symlink' });

describe('planUsr', () => {
  it('binds /usr whole when nothing is mounted below it', () => {
    const r = planUsr(env(['/', '/proc'], {}));
    expect(r.ok && r.value).toEqual([{ kind: 'bind-dir', src: '/usr', tgt: '/usr' }]);
  });

  it('skips submounts, descends only where needed and keeps order parent-first', () => {
    const tree = {
      '/usr': [d('lib'), d('bin'), l('lib64'), f('stray')],
      '/usr/lib': [d('wsl'), d('x86_64-linux-gnu'), f('os-release'), d('modules')],
      '/usr/lib/wsl': [d('drivers'), d('lib'), f('wsl-setup')],
      '/usr/lib/modules': [d('6.18')],
    };
    const r = planUsr(
      env(['/', '/usr/lib/wsl/drivers', '/usr/lib/wsl/lib', '/usr/lib/modules/6.18'], tree, {
        '/usr/lib64': 'usr/lib64',
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([
      { kind: 'mkdir', src: '', tgt: '/usr' },
      { kind: 'bind-dir', src: '/usr/bin', tgt: '/usr/bin' },
      { kind: 'mkdir', src: '', tgt: '/usr/lib' },
      { kind: 'mkdir', src: '', tgt: '/usr/lib/modules' },
      { kind: 'bind-file', src: '/usr/lib/os-release', tgt: '/usr/lib/os-release' },
      { kind: 'mkdir', src: '', tgt: '/usr/lib/wsl' },
      { kind: 'bind-file', src: '/usr/lib/wsl/wsl-setup', tgt: '/usr/lib/wsl/wsl-setup' },
      { kind: 'bind-dir', src: '/usr/lib/x86_64-linux-gnu', tgt: '/usr/lib/x86_64-linux-gnu' },
      { kind: 'symlink', src: 'usr/lib64', tgt: '/usr/lib64' },
      { kind: 'bind-file', src: '/usr/stray', tgt: '/usr/stray' },
    ]);
    const targets = r.value.map((e) => e.tgt);
    expect(targets).not.toContain('/usr/lib/wsl/drivers');
    expect(targets).not.toContain('/usr/lib/wsl/lib');
    expect(targets).not.toContain('/usr/lib/modules/6.18');
  });

  it('never plans a path that is a mount point', () => {
    const tree = { '/usr': [d('a'), d('b')] };
    const r = planUsr(env(['/usr/a/deep'], { ...tree, '/usr/a': [d('deep')] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const e of r.value) expect(e.tgt).not.toBe('/usr/a/deep');
  });

  it('refuses a plan over the entry cap instead of truncating', () => {
    const many = Array.from({ length: 600 }, (_, i) => d(`d${String(i)}`));
    const r = planUsr(env(['/usr/z/mnt'], { '/usr': many }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E2BIG');
  });

  it('propagates read errors', () => {
    const r = planUsr(env(['/usr/lib/wsl/drivers'], {}));
    expect(r.ok).toBe(false);
  });
});
