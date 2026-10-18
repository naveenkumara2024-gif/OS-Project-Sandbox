import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Dialer, Resolver } from '../../src/broker/broker.js';
import { helperBuilds, request, runWith, sh, testGovernance } from '../helpers/cell.js';

// Probe 5: connect to 1.1.1.1:443 and to the Windows gateway. Layer expected to stop it: the
// network namespace (no interface but a down loopback, no route). Since Stage 4 Landlock also
// refuses TCP connect, so the error may be "Permission denied" before the route lookup happens.

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
    expect(r.stdout).toMatch(
      /Network is unreachable|Connection refused|No route|Permission denied/,
    );
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

// With the egress broker on (Stage 5): the cell has a loopback and a proxy, and still cannot reach
// the internet or the Windows gateway directly; through the proxy the gateway is refused.
const dials: string[] = [];
const resolver: Resolver = (host) =>
  host === 'windows-host.test' && gateway !== null
    ? Promise.resolve([gateway])
    : Promise.resolve(['93.184.216.34']);
const dial: Dialer = (ip, port) => {
  dials.push(`${ip}:${String(port)}`);
  return Promise.reject(new Error('stand-in: connects nowhere'));
};

describe.each(helperBuilds())('probe 5 with the broker on ($name build)', (helper) => {
  it.skipIf(gateway === null)(
    'direct connects still fail, and the gateway is refused through the proxy',
    async () => {
      dials.length = 0;
      const script = [
        'import socket',
        'def direct(label, host, port):',
        '    s = socket.socket(); s.settimeout(3)',
        '    try:',
        '        s.connect((host, port)); print(label, "CONNECTED")',
        '    except OSError as e:',
        '        print(label, "denied", e.errno)',
        'direct("internet", "1.1.1.1", 443)',
        ...[53, 445, 135].map(
          (p) => `direct("gateway-${String(p)}", "${gateway ?? ''}", ${String(p)})`,
        ),
        's = socket.create_connection(("127.0.0.1", 3128), timeout=5)',
        's.sendall(b"CONNECT windows-host.test:443 HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n")',
        'print("proxy", s.recv(200).split(b"\\r\\n")[0].decode())',
      ].join('\n');
      const r = await runWith(
        helper,
        request(['/usr/bin/python3', '-c', script], {
          manifest: { network: { mode: 'brokered', allow: ['windows-host.test'] } },
        }),
        {
          governance: testGovernance({ networkAllow: ['windows-host.test'] }),
          broker: { resolver, dial },
        },
      );
      expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
      expect(r.stdout).not.toContain('CONNECTED');
      expect(r.stdout.match(/denied 13/g)?.length).toBe(4); // Landlock: EACCES
      expect(r.stdout).toContain('proxy HTTP/1.1 403');
      expect(r.network.audit?.[0]).toMatchObject({
        host: 'windows-host.test',
        reason: 'private_address',
      });
      expect(dials).toEqual([]);
    },
  );
});
