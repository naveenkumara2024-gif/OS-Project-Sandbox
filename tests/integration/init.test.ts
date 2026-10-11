import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { helperBuilds, request, runIn, sh } from '../helpers/cell.js';

describe.each(helperBuilds())('aegis-cell init ($name build)', (helper) => {
  it('reaps orphans: no zombie is left in the cell', async () => {
    // The inner shell exits at once and its sleeps are reparented to init, which must reap them.
    const r = await sh(
      helper,
      [
        "sh -c 'sleep 0.05 & sleep 0.05 & exit 0'",
        'sleep 0.4',
        "cat /proc/[0-9]*/stat | cut -d' ' -f3 | sort | uniq -c | tr -s ' '",
      ].join('; '),
    );
    expect(r.termination).toEqual({ cause: 'exit' });
    expect(r.stdout).not.toMatch(/\sZ\s*$/m);
    expect(r.stdout).toMatch(/S|R/);
  });

  it('reports the payload exit code and signal death through init', async () => {
    const a = await sh(helper, 'exit 9');
    expect(a.termination).toEqual({ cause: 'exit' });
    expect(a.exit_code).toBe(9);
    const b = await runIn(
      helper,
      request(['/usr/bin/python3', '-c', 'import os,signal; os.kill(os.getpid(), signal.SIGABRT)']),
    );
    expect(b.termination).toEqual({ cause: 'signal:SIGABRT' });
    expect(b.exit_code).toBeNull();
  });

  it('ends the cell when the payload ends, taking its background processes along', async () => {
    const t0 = Date.now();
    const r = await sh(helper, 'sleep 30 & echo started; exit 0');
    expect(r.termination).toEqual({ cause: 'exit' });
    expect(r.stdout).toBe('started\n');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('refuses to run outside a cell, so it is not a usable tool on the host', () => {
    const r = spawnSync(helper.path, ['init', '--', '/usr/bin/echo', 'HOST-EXEC'], {
      encoding: 'utf8',
      env: {},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(r.status).toBe(64);
    expect(r.stdout).not.toContain('HOST-EXEC');
  });

  it('keeps the status descriptor away from the payload', async () => {
    const r = await sh(helper, 'ls /proc/self/fd | sort -n | tr "\\n" " "');
    const fds = r.stdout.trim().split(' ').map(Number);
    for (const fd of fds) expect(fd).toBeLessThanOrEqual(3);
  });
});
