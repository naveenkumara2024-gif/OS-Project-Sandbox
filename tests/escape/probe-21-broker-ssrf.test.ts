import { readFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Dialer, Resolver } from '../../src/broker/broker.js';
import { hostRangesFromRoutes } from '../../src/broker/address-policy.js';
import { helperBuilds, request, runWith, testGovernance } from '../helpers/cell.js';

// Probe 21 (Stage 5): make the egress broker connect to something internal. Names that resolve to
// loopback, cloud metadata, private ranges, this machine's own gateway (the Windows host under
// WSL2) and to a mix of public and internal addresses, plus every spelling trick for an address
// or a second host in the CONNECT line, and ports other than 443. The stand-in for "the world"
// is a local server; if the broker ever dials, the server sees it. Layers expected to stop it:
// the broker's address policy and request parser.

const gatewayIp = ((): string => {
  const ranges = hostRangesFromRoutes(readFileSync('/proc/net/route', 'utf8'));
  const gw = ranges.find((r) => r.bits === 32);
  if (gw === undefined) return '172.22.80.1';
  return [gw.base >>> 24, (gw.base >>> 16) & 255, (gw.base >>> 8) & 255, gw.base & 255].join('.');
})();

const PUBLIC = '93.184.216.34';
const NAMES: Record<string, string[]> = {
  'allowed.test': [PUBLIC],
  'loopback.test': ['127.0.0.1'],
  'metadata.test': ['169.254.169.254'],
  'private.test': ['10.1.2.3'],
  'private2.test': ['192.168.1.10'],
  'cgnat.test': ['100.64.0.9'],
  'gateway.test': [gatewayIp],
  'mixed.test': [PUBLIC, '127.0.0.1'],
  'mixed2.test': ['10.0.0.1', PUBLIC],
  'v6loopback.test': ['::1'],
  'v6mapped.test': ['::ffff:10.0.0.1'],
  'v6ula.test': ['fd00::1'],
  'nat64.test': ['64:ff9b::a00:1'],
};
const resolver: Resolver = (host) => {
  const ips = NAMES[host];
  return ips === undefined ? Promise.reject(new Error('NXDOMAIN')) : Promise.resolve(ips);
};

let world: Server;
let worldPort = 0;
let worldHits = 0;
let dials: string[] = [];
// Whatever address the broker asks for, this connects to the local decoy server. A refusal
// therefore means the broker did not dial; if policy ever let an internal target through, the
// decoy would see the connection (worldHits) and the address would be in `dials`.
const dial: Dialer = (ip, port) => {
  dials.push(`${ip}:${String(port)}`);
  return new Promise((resolve, reject) => {
    const s = connect(worldPort, '127.0.0.1');
    s.once('connect', () => {
      resolve(s);
    });
    s.once('error', reject);
  });
};

beforeAll(async () => {
  world = createServer((s) => {
    worldHits++;
    s.destroy();
  });
  await new Promise<void>((r) => world.listen(0, '127.0.0.1', r));
  const a = world.address();
  worldPort = typeof a === 'object' && a !== null ? a.port : 0;
});
afterAll(async () => {
  await new Promise<void>((r) =>
    world.close(() => {
      r();
    }),
  );
});

const PROBE = [
  'import socket, json',
  'def via_proxy(label, head):',
  '    s = socket.create_connection(("127.0.0.1", 3128), timeout=8)',
  '    s.sendall(head.encode("latin1"))',
  '    data = b""',
  '    try:',
  '        while b"\\r\\n" not in data: data += s.recv(512)',
  '    except OSError: pass',
  '    s.close()',
  '    print(json.dumps([label, data.split(b"\\r\\n")[0].decode("latin1")]))',
  'C = lambda a, extra="": "CONNECT %s HTTP/1.1\\r\\nHost: x\\r\\n%s\\r\\n" % (a, extra)',
  'cases = json.loads(open("/dev/stdin").read()) if False else None',
].join('\n');

const NAMES_UNDER_TEST = [
  'loopback.test',
  'metadata.test',
  'private.test',
  'private2.test',
  'cgnat.test',
  'gateway.test',
  'mixed.test',
  'mixed2.test',
  'v6loopback.test',
  'v6mapped.test',
  'v6ula.test',
  'nat64.test',
];

const TRICKS: [string, string][] = [
  ['userinfo', 'evil.example@allowed.test:443'],
  ['userinfo2', 'allowed.test:443@evil.example:443'],
  ['ipv4', '93.184.216.34:443'],
  ['ipv4-loopback', '127.0.0.1:443'],
  ['short-ipv4', '127.1:443'],
  ['decimal-ipv4', '2130706433:443'],
  ['hex-ipv4', '0x7f000001:443'],
  ['dotted-hex', '0x7f.0.0.1:443'],
  ['octal', '0177.0.0.1:443'],
  ['bracketed-v6', '[::1]:443'],
  ['bracketed-mapped', '[::ffff:7f00:1]:443'],
  ['percent', 'allowed%2etest:443'],
  ['path', 'allowed.test:443/x'],
  ['no-port', 'allowed.test'],
  ['port-22', 'allowed.test:22'],
  ['port-25', 'allowed.test:25'],
  ['port-80', 'allowed.test:80'],
  ['port-0', 'allowed.test:0'],
  ['port-65536', 'allowed.test:65536'],
  ['port-leading-zero', 'allowed.test:0443'],
];

describe.each(helperBuilds())('probe 21: broker SSRF and rebinding ($name build)', (helper) => {
  it('control: the allowlisted public name is connected (by the stub dialer, to the address it checked)', async () => {
    dials = [];
    worldHits = 0;
    const r = await runWith(
      helper,
      request(['/usr/bin/python3', '-c', `${PROBE}\nvia_proxy("ok", C("allowed.test:443"))`], {
        manifest: { network: { mode: 'brokered', allow: ['allowed.test'] } },
      }),
      {
        governance: testGovernance({ networkAllow: ['allowed.test'] }),
        broker: { resolver, dial },
      },
    );
    // The policy let this one through and connected to exactly the address it had checked.
    expect(r.stdout).toContain('HTTP/1.1 200');
    expect(dials).toEqual([`${PUBLIC}:443`]);
    expect(worldHits).toBe(1);
    expect(r.network.audit?.[0]).toMatchObject({
      host: 'allowed.test',
      decision: 'allow',
      resolved: PUBLIC,
    });
  });

  it('refuses every internal-resolving name and never dials', async () => {
    dials = [];
    worldHits = 0;
    const script = `${PROBE}\n${NAMES_UNDER_TEST.map((n) => `via_proxy(${JSON.stringify(n)}, C(${JSON.stringify(`${n}:443`)}))`).join('\n')}`;
    const r = await runWith(
      helper,
      request(['/usr/bin/python3', '-c', script], {
        manifest: { network: { mode: 'brokered', allow: NAMES_UNDER_TEST } },
      }),
      {
        governance: testGovernance({ networkAllow: NAMES_UNDER_TEST }),
        broker: { resolver, dial },
      },
    );
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    const rows = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as [string, string]);
    expect(rows).toHaveLength(NAMES_UNDER_TEST.length);
    for (const [label, status] of rows) expect(status, label).toMatch(/^HTTP\/1.1 403/);
    expect(dials).toEqual([]);
    expect(worldHits).toBe(0);
    const audit = r.network.audit ?? [];
    expect(audit).toHaveLength(NAMES_UNDER_TEST.length);
    for (const e of audit)
      expect(e, e.host).toMatchObject({ decision: 'deny', reason: 'private_address' });
  });

  it('refuses every address spelling, second-host trick and wrong port before any lookup', async () => {
    dials = [];
    worldHits = 0;
    const script = `${PROBE}\n${TRICKS.map(([l, a]) => `via_proxy(${JSON.stringify(l)}, C(${JSON.stringify(a)}))`).join('\n')}\nvia_proxy("get", "GET http://allowed.test/ HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n")\nvia_proxy("body", C("allowed.test:443", "Content-Length: 5\\r\\n") + "hello")`;
    const r = await runWith(
      helper,
      request(['/usr/bin/python3', '-c', script], {
        manifest: { network: { mode: 'brokered', allow: ['allowed.test'] } },
      }),
      {
        governance: testGovernance({ networkAllow: ['allowed.test'] }),
        broker: { resolver, dial },
      },
    );
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    const rows = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as [string, string]);
    expect(rows).toHaveLength(TRICKS.length + 2);
    for (const [label, status] of rows) {
      expect(status, label).toMatch(/^HTTP\/1.1 (400|403|405)/);
    }
    expect(dials).toEqual([]);
    expect(worldHits).toBe(0);
    expect((r.network.audit ?? []).every((e) => e.decision === 'deny')).toBe(true);
  });
});
