import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { helperBuilds, sh } from '../helpers/cell.js';

// Probe 11: `kill -9 -1` and signals to host PIDs. Layer expected to stop it: the pid namespace.
// The sentinel is a host process the harness owns; it must survive every attempt.
let sentinel: ChildProcess;
let pid = 0;

function alive(p: number): boolean {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  // Keep spawning until the pid is well above anything a small fresh namespace would hand out,
  // so a collision cannot make the probe pass or fail for the wrong reason.
  for (let i = 0; i < 50; i++) {
    const c = spawn('/usr/bin/sleep', ['600'], { stdio: 'ignore', env: {}, shell: false });
    if (c.pid !== undefined && c.pid > 1000) {
      sentinel = c;
      pid = c.pid;
      return;
    }
    c.kill('SIGKILL');
  }
  throw new Error('could not obtain a high-numbered sentinel pid');
});

afterAll(() => {
  sentinel.kill('SIGKILL');
});

describe.each(helperBuilds())('probe 11: signals ($name build)', (helper) => {
  it('cannot see or signal a host process', async () => {
    const r = await sh(
      helper,
      [
        `ls /proc/${String(pid)} 2>&1; echo visible-rc=$?`,
        `kill -9 ${String(pid)} 2>&1; echo kill-rc=$?`,
        `kill -TERM ${String(pid)} 2>&1; echo term-rc=$?`,
      ].join('; '),
    );
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    expect(r.stdout).toMatch(/visible-rc=[1-9]/);
    expect(r.stdout).toMatch(/kill-rc=[1-9]/);
    expect(r.stdout).toMatch(/term-rc=[1-9]/);
    expect(r.stdout).toMatch(/No such (process|file)/);
    expect(alive(pid)).toBe(true);
  });

  it('kill -9 -1 reaches only the cell', async () => {
    const r = await sh(
      helper,
      [
        'sleep 100 & p1=$!',
        'sleep 100 & p2=$!',
        'sleep 0.2',
        'kill -9 -1; echo killall-rc=$?',
        'wait $p1; echo p1-wait=$?',
        'wait $p2; echo p2-wait=$?',
      ].join('; '),
    );
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    expect(r.stdout).toMatch(/killall-rc=0/);
    // 137 = 128 + SIGKILL: both cell processes were killed by it.
    expect(r.stdout).toMatch(/p1-wait=137/);
    expect(r.stdout).toMatch(/p2-wait=137/);
    expect(alive(pid)).toBe(true);
  });
});
