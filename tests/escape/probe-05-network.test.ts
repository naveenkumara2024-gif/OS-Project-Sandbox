import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { helperBuilds, sh } from '../helpers/cell.js';

// Probe 5: connect to 1.1.1.1:443 and to the Windows gateway. Layer expected to stop it: the
// network namespace (no interface but a down loopback, no route).

/** The host's default gateway, which under WSL2 NAT is the Windows side. */
function defaultGateway(): string | null {
  for (const line of readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
    const f = line.split(/\s+/);
    if (f[1] === '00000000' && f[2] !== undefined && /^[0-9A-F]{8}$/.test(f[2])) {
      const n = parseInt(f[2], 16);
      return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join('.');
    }
  }
  return null;
}

const gateway = defaultGateway();

describe.each(helperBuilds())('probe 5: network ($name build)', (helper) => {
  it('cannot reach the internet and has no usable interface', async () => {
    const r = await sh(
      helper,
      [
        `/usr/bin/bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>&1; echo net-rc=$?`,
        `echo IFACES:; tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '`,
        `echo ROUTES:; tail -n +2 /proc/net/route | wc -l`,
      ].join('; '),
    );
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    expect(r.stdout).toMatch(/net-rc=[1-9]/);
    expect(r.stdout).toMatch(/Network is unreachable|Connection refused|No route/);
    const ifaces = r.stdout.split('IFACES:\n')[1]?.split('ROUTES:')[0]?.trim().split('\n');
    expect(ifaces).toEqual(['lo']);
    expect(r.stdout.split('ROUTES:\n')[1]?.trim()).toBe('0');
  });

  it.skipIf(gateway === null)('cannot reach the Windows gateway', async () => {
    const r = await sh(
      helper,
      `for p in 53 445 135; do /usr/bin/bash -c "exec 3<>/dev/tcp/${gateway ?? ''}/$p" 2>&1; echo gw-$p-rc=$?; done`,
    );
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    for (const p of [53, 445, 135]) {
      expect(r.stdout).toMatch(new RegExp(`gw-${String(p)}-rc=[1-9]`));
    }
    expect(r.stdout).not.toMatch(/gw-\d+-rc=0/);
  });
});
