import { mkdtempSync, readdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type PlanEnv } from '../../src/launch/rootfs-plan.js';
import { parseMountInfo } from '../../src/probe/procfs.js';
import { RECEIPT_LAYERS } from '../../src/sys/status.js';
import { err, ok } from '../../src/util/result.js';
import { helperBuilds, request, runIn, sh } from '../helpers/cell.js';

// needs_userns: these tests create real cells. If the kernel cannot, they fail with the helper's
// layer and errno in the assertion message; they are never skipped (CLAUDE.md 7).

/** A private parent for per-cell directories, so concurrent test files cannot disturb the count. */
function privateParent(): string {
  return mkdtempSync(join(tmpdir(), 'aegis-parent-'));
}

function expectEmptyAndRemove(parent: string): void {
  expect(readdirSync(parent)).toEqual([]);
  rmdirSync(parent);
}

describe.each(helperBuilds())('cell ($name build)', (helper) => {
  it('runs a command and reports all eleven layers as established', async () => {
    const r = await runIn(helper, request(['/usr/bin/echo', 'hi']));
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toBe('hi\n');
    expect(r.stderr).toBe('');
    for (const layer of RECEIPT_LAYERS) {
      expect(r.isolation.layers[layer], layer).toBe(true);
    }
  });

  it('passes non-zero exit codes through', async () => {
    const r = await sh(helper, 'exit 7');
    expect(r.termination).toEqual({ cause: 'exit' });
    expect(r.exit_code).toBe(7);
  });

  it('classifies a signal death from a real fault', async () => {
    // A synchronous fault is forced onto the process even when it is PID 1 of its namespace.
    const r = await runIn(
      helper,
      request(['/usr/bin/python3', '-c', 'import ctypes; ctypes.string_at(0)']),
    );
    expect(r.termination).toEqual({ cause: 'signal:SIGSEGV' });
    expect(r.exit_code).toBeNull();
  });

  it('documents that PID 1 ignores in-cell signals with the default action', async () => {
    // Kernel rule for namespace init (pid_namespaces(7)); Stage 2 puts aegis-cell init here.
    const r = await sh(helper, 'kill -SEGV $$; kill -KILL $$; echo survived');
    expect(r.termination).toEqual({ cause: 'exit' });
    expect(r.stdout).toBe('survived\n');
  });

  it('kills the whole cell on wall-clock timeout and removes the cell directory', async () => {
    const parent = privateParent();
    const t0 = Date.now();
    const r = await sh(helper, 'sleep 30 & sleep 30', { limits: { wall_ms: 400 } }, parent);
    const took = Date.now() - t0;
    expect(r.termination).toEqual({ cause: 'timeout' });
    expect(took).toBeGreaterThanOrEqual(350);
    expect(took).toBeLessThan(4000);
    expectEmptyAndRemove(parent);
  });

  it('stops an output flood at the cap', async () => {
    const r = await sh(helper, 'yes aaaaaaaaaaaaaaaaaaaaaaaa', { limits: { output_kb: 4 } });
    expect(r.termination).toEqual({ cause: 'output_limit', stream: 'stdout' });
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(4096);
  });

  it('gives the payload the single-id user namespace, hostname and a private root', async () => {
    const r = await sh(
      helper,
      'cat /proc/self/uid_map; cat /proc/self/gid_map; cat /proc/self/setgroups; hostname; ls -A /',
    );
    expect(r.termination).toEqual({ cause: 'exit' });
    const uid = String(process.getuid?.() ?? -1);
    const gid = String(process.getgid?.() ?? -1);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]?.trim().split(/\s+/)).toEqual(['0', uid, '1']);
    expect(lines[1]?.trim().split(/\s+/)).toEqual(['0', gid, '1']);
    expect(lines[2]).toBe('deny');
    expect(lines[3]).toBe('aegis');
    expect(lines.slice(4).sort()).toEqual(
      ['bin', 'dev', 'etc', 'lib', 'lib64', 'proc', 'sbin', 'tmp', 'usr'].sort(),
    );
  });

  it('exposes only the planned read-only mounts, none of them 9p or overlay', async () => {
    const r = await sh(helper, 'cat /proc/self/mountinfo');
    expect(r.termination).toEqual({ cause: 'exit' });
    const mounts = parseMountInfo(r.stdout);
    expect(mounts.length).toBeGreaterThan(0);
    for (const m of mounts) {
      const p = m.mountPoint;
      const allowed =
        p === '/' ||
        p === '/proc' ||
        p === '/tmp' ||
        p === '/dev' ||
        p.startsWith('/dev/') ||
        p.startsWith('/usr/');
      expect(allowed, `unexpected mount ${p}`).toBe(true);
      expect(['9p', 'overlay', 'drvfs', 'virtiofs']).not.toContain(m.fsType);
    }
    const lines = r.stdout.split('\n').filter((l) => / \/usr\//.test(l));
    expect(lines.length).toBeGreaterThan(10);
    for (const l of lines) {
      const opts = l.split(' ')[5] ?? '';
      expect(opts.split(',')).toEqual(expect.arrayContaining(['ro', 'nosuid', 'nodev']));
    }
  });

  it('does not leak the WSL driver store or kernel module mounts', async () => {
    const r = await sh(helper, 'ls /usr/lib/wsl/drivers 2>&1; ls /usr/lib/modules 2>&1');
    expect(r.stdout).not.toMatch(/\.inf_/);
    expect(r.stdout).toContain('No such file or directory');
  });

  it('has only descriptors 0, 1 and 2 (plus the directory handle ls itself opens)', async () => {
    const r = await sh(
      helper,
      'for f in /proc/self/fd/*; do echo ${f##*/}; done | sort -n | tr "\\n" " "',
    );
    expect(r.termination).toEqual({ cause: 'exit' });
    // The shell's own handle for the glob may appear; anything above 3 would be a leak.
    const fds = r.stdout.trim().split(' ').map(Number);
    for (const fd of fds) expect(fd).toBeLessThanOrEqual(3);
    expect(fds).toEqual(expect.arrayContaining([0, 1, 2]));
  });

  it('shows only the cell in /proc and starts as pid 1', async () => {
    const r = await sh(helper, 'echo $$; ls /proc | grep -E "^[0-9]+$" | sort -n | tr "\\n" " "');
    const [self, pids] = r.stdout.split('\n');
    expect(self).toBe('1');
    for (const p of (pids ?? '').trim().split(' ')) expect(Number(p)).toBeLessThan(100);
  });

  it('gives the payload exactly the request environment plus the fixed PATH', async () => {
    const r = await runIn(
      helper,
      request(['/usr/bin/env'], { env: { ALPHA: '1', BETA: 'two words' } }),
    );
    const got = r.stdout.trim().split('\n').sort();
    expect(got).toEqual(['ALPHA=1', 'BETA=two words', 'PATH=/usr/bin:/bin'].sort());
  });

  it('does not offer Node.js inside the cell', async () => {
    const r = await sh(
      helper,
      'test -s /usr/bin/node; echo $?; /usr/bin/node --version 2>&1 | head -c 80',
    );
    const first = r.stdout.split('\n')[0];
    expect(first).toBe('1');
    expect(r.stdout).not.toMatch(/^v\d+\./m);
  });

  it('refuses to run, naming the root layer, when a planned bind cannot be made', async () => {
    // The plan asks to bind a directory that does not exist; mountinfo claims a mount below /usr
    // so the planner descends and emits exactly that one bad entry.
    const env: PlanEnv = {
      readMountInfo: () => ok('1 1 0:1 / /usr/some/mount rw - ext4 x rw'),
      listDir: () => ok([{ name: 'does-not-exist-aegis', kind: 'dir' }]),
      readLink: () => err('ENOENT', 'none'),
    };
    const r = await runIn(helper, request(['/usr/bin/echo', 'MUST-NOT-RUN']), env);
    expect(r.termination).toMatchObject({ cause: 'isolation_unavailable', layer: 'root' });
    expect(r.error).toMatchObject({
      code: 'isolation_unavailable',
      layer: 'root',
      errno: 'ENOENT',
    });
    expect(r.stdout).toBe('');
    expect(r.exit_code).toBeNull();
    expect(r.isolation.layers.root).toBe(false);
  });

  it('survives 1000 near-simultaneous exit and timeout races without a wrong answer', async () => {
    const parent = privateParent();
    const causes = new Map<string, number>();
    const total = 1000;
    const batch = 8;
    for (let i = 0; i < total; i += batch) {
      const rs = await Promise.all(
        Array.from({ length: Math.min(batch, total - i) }, () =>
          sh(helper, 'sleep 0.01', { limits: { wall_ms: 40 } }, parent),
        ),
      );
      for (const r of rs) {
        const c = r.termination.cause;
        causes.set(c, (causes.get(c) ?? 0) + 1);
        expect(['exit', 'timeout'], JSON.stringify(r)).toContain(c);
        if (c === 'exit') expect(r.exit_code).toBe(0);
      }
    }
    expect([...causes.values()].reduce((a, b) => a + b, 0)).toBe(total);
    expectEmptyAndRemove(parent);
  }, 300_000);
});
