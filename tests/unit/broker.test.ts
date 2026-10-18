import { lstatSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/broker/audit.js';
import { Broker, type BrokerOptions, type Dialer, type Resolver } from '../../src/broker/broker.js';

// The broker against stubbed DNS and a local target. The stubs make the policy visible: the
// names below resolve to internal addresses, but the dialer would reach a local server if the
// broker ever tried to connect, and the tests assert that it never does.

let dir = '';
let target: Server;
let targetPort = 0;
let dials: { ip: string; port: number }[] = [];
let broker: Broker | null = null;
let audit: AuditLog;

const PUBLIC = '93.184.216.34';
const DNS: Record<string, string[]> = {
  'allowed.test': [PUBLIC],
  'rebind.test': [PUBLIC, '10.0.0.5'],
  'rebind2.test': ['10.0.0.5', PUBLIC],
  'internal.test': ['169.254.169.254'],
  'loop.test': ['127.0.0.1'],
  'gw.test': ['172.22.80.1'],
  'v6.test': ['::1'],
  'mapped.test': ['::ffff:10.0.0.1'],
  'cgnat.test': ['100.64.1.1'],
  'empty.test': [],
};
const resolver: Resolver = (host) => {
  if (host === 'fail.test') return Promise.reject(new Error('NXDOMAIN'));
  if (host === 'slow.test') return new Promise(() => undefined);
  const ips = DNS[host];
  return ips === undefined ? Promise.reject(new Error('NXDOMAIN')) : Promise.resolve(ips);
};
const dial: Dialer = (ip, port) => {
  dials.push({ ip, port });
  if (ip === PUBLIC && port === 443) {
    return new Promise((resolve, reject) => {
      const s = connect(targetPort, '127.0.0.1');
      s.once('connect', () => {
        resolve(s);
      });
      s.once('error', reject);
    });
  }
  return Promise.reject(new Error('unreachable'));
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aegis-broker-'));
  dials = [];
  audit = new AuditLog();
  target = createServer((s) => {
    s.on('data', (d) => s.write(d)); // echo
    s.on('error', () => undefined);
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  const addr = target.address();
  targetPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
});
afterEach(async () => {
  await broker?.close();
  broker = null;
  await new Promise<void>((r) =>
    target.close(() => {
      r();
    }),
  );
  rmSync(dir, { recursive: true, force: true });
});

async function start(over: Partial<BrokerOptions> = {}): Promise<string> {
  const sock = join(dir, 'broker.sock');
  const r = await Broker.create({
    socketPath: sock,
    run: 'r-test',
    manifestSha256: 'ab'.repeat(32),
    allow: Object.keys(DNS).concat(['fail.test', 'slow.test']),
    ports: [443],
    hostRanges: [{ base: (172 << 24) | (22 << 16) | (80 << 8), bits: 20 }],
    audit,
    resolver,
    dial,
    ...over,
  });
  if (!r.ok) throw new Error(r.error.context);
  broker = r.value;
  return sock;
}

interface Exchange {
  head: string;
  body: string;
  socket: Socket;
}

/** Sends `data`, waits for the response head, and optionally for `echo` bytes after it. */
function exchange(sock: string, data: string, opts: { waitMs?: number } = {}): Promise<Exchange> {
  return new Promise((resolve) => {
    const s = connect(sock);
    let got = '';
    s.on('data', (d) => (got += d.toString('latin1')));
    s.on('error', () => undefined);
    s.write(data, 'latin1');
    setTimeout(() => {
      const i = got.indexOf('\r\n\r\n');
      resolve({
        head: i < 0 ? got : got.slice(0, i),
        body: i < 0 ? '' : got.slice(i + 4),
        socket: s,
      });
    }, opts.waitMs ?? 150);
  });
}

const CONNECT = (host: string, port = 443) =>
  `CONNECT ${host}:${String(port)} HTTP/1.1\r\nHost: ${host}\r\n\r\n`;

describe('Broker tunnelling', () => {
  it('connects an allowlisted host, relays both ways, and audits bytes and the address used', async () => {
    const sock = await start();
    const x = await exchange(sock, CONNECT('allowed.test'));
    expect(x.head).toMatch(/^HTTP\/1.1 200 Connection Established/);
    x.socket.write('hello');
    await new Promise((r) => setTimeout(r, 100));
    x.socket.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(dials).toEqual([{ ip: PUBLIC, port: 443 }]);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      host: 'allowed.test',
      port: 443,
      decision: 'allow',
      reason: 'ok',
      resolved: PUBLIC,
      bytes_up: 5,
      bytes_down: 5,
    });
  });

  it('forwards bytes sent right behind the head (the start of a TLS handshake)', async () => {
    const sock = await start();
    const x = await exchange(sock, `${CONNECT('allowed.test')}EARLY`);
    expect(x.head).toMatch(/^HTTP\/1.1 200/);
    expect(x.body).toBe('EARLY');
    x.socket.destroy();
  });

  it('normalises the name before the allowlist check', async () => {
    const sock = await start();
    const x = await exchange(sock, CONNECT('ALLOWED.Test.'));
    expect(x.head).toMatch(/^HTTP\/1.1 200/);
    x.socket.destroy();
  });

  it('uses the socket with mode 0600', async () => {
    const sock = await start();
    expect(lstatSync(sock).mode & 0o777).toBe(0o600);
  });
});

describe('Broker refusals (probe 21 material)', () => {
  it('refuses a host that is not on the allowlist without resolving or dialing', async () => {
    const sock = await start({ allow: ['allowed.test'] });
    const x = await exchange(sock, CONNECT('evil.example'));
    expect(x.head).toMatch(/^HTTP\/1.1 403/);
    expect(dials).toEqual([]);
    expect(audit.entries[0]).toMatchObject({
      host: 'evil.example',
      decision: 'deny',
      reason: 'not_allowlisted',
    });
  });

  it.each([22, 25, 80, 8443, 65535])('refuses port %i (only 443 is allowed)', async (port) => {
    const sock = await start();
    const x = await exchange(sock, CONNECT('allowed.test', port));
    expect(x.head).toMatch(/^HTTP\/1.1 403/);
    expect(dials).toEqual([]);
    expect(audit.entries[0]).toMatchObject({ port, reason: 'port_not_allowed' });
  });

  it.each([
    'internal.test',
    'loop.test',
    'gw.test',
    'v6.test',
    'mapped.test',
    'cgnat.test',
    'empty.test',
  ])('refuses %s because it resolves to an internal address, and never dials', async (host) => {
    const sock = await start();
    const x = await exchange(sock, CONNECT(host));
    expect(x.head).toMatch(/^HTTP\/1.1 403/);
    expect(dials).toEqual([]);
    expect(audit.entries[0]).toMatchObject({ host, decision: 'deny', reason: 'private_address' });
  });

  it('refuses a rebinding name that maps to a public AND an internal address, in either order', async () => {
    const sock = await start();
    for (const host of ['rebind.test', 'rebind2.test']) {
      const x = await exchange(sock, CONNECT(host));
      expect(x.head, host).toMatch(/^HTTP\/1.1 403/);
    }
    expect(dials).toEqual([]);
    expect(audit.entries.map((e) => e.reason)).toEqual(['private_address', 'private_address']);
  });

  it('answers 502 for a name that does not resolve, and when resolution hangs', async () => {
    const sock = await start({ limits: { resolveMs: 100 } });
    for (const host of ['fail.test', 'slow.test']) {
      const x = await exchange(sock, CONNECT(host), { waitMs: 400 });
      expect(x.head, host).toMatch(/^HTTP\/1.1 502/);
    }
    expect(audit.entries.map((e) => e.reason)).toEqual(['resolve_failed', 'resolve_failed']);
  });

  it('answers 502 when the connection to the checked address fails', async () => {
    const sock = await start({ dial: () => Promise.reject(new Error('refused')) });
    const x = await exchange(sock, CONNECT('allowed.test'));
    expect(x.head).toMatch(/^HTTP\/1.1 502/);
    expect(audit.entries[0]).toMatchObject({ reason: 'connect_failed', decision: 'deny' });
  });

  it.each([
    ['userinfo', 'CONNECT evil.com@allowed.test:443 HTTP/1.1\r\n\r\n', 400],
    ['bracketed IPv6', 'CONNECT [::1]:443 HTTP/1.1\r\n\r\n', 400],
    ['decimal IP', 'CONNECT 2130706433:443 HTTP/1.1\r\n\r\n', 400],
    ['dotted IP', 'CONNECT 93.184.216.34:443 HTTP/1.1\r\n\r\n', 400],
    ['short IP', 'CONNECT 127.1:443 HTTP/1.1\r\n\r\n', 400],
    ['hex IP', 'CONNECT 0x7f.0.0.1:443 HTTP/1.1\r\n\r\n', 400],
    ['GET', 'GET http://allowed.test/ HTTP/1.1\r\n\r\n', 405],
    ['no port', 'CONNECT allowed.test HTTP/1.1\r\n\r\n', 400],
    ['smuggled body', 'CONNECT allowed.test:443 HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello', 400],
    ['garbage', '\x00\x01\x02\r\n\r\n', 400],
  ])('refuses %s before any lookup', async (_name, request, status) => {
    const sock = await start();
    const x = await exchange(sock, request);
    expect(x.head).toMatch(new RegExp(`^HTTP/1.1 ${String(status)}`));
    expect(dials).toEqual([]);
    expect(audit.entries[0]?.decision).toBe('deny');
  });

  it('refuses an oversize head and times out a head that never ends', async () => {
    const sock = await start({ limits: { headMs: 150 } });
    const big = await exchange(sock, `CONNECT allowed.test:443 HTTP/1.1\r\nX: ${'a'.repeat(9000)}`);
    expect(big.head).toMatch(/^HTTP\/1.1 400/);
    const slow = await exchange(sock, 'CONNECT allowed.test:443 HTTP/1.1\r\nHost: x\r\n', {
      waitMs: 400,
    });
    expect(slow.head).toMatch(/^HTTP\/1.1 400/);
    expect(dials).toEqual([]);
  });
});

describe('Broker limits', () => {
  it('allows at most maxTunnels at once; the next is answered 429 and audited', async () => {
    const sock = await start({ limits: { maxTunnels: 2 } });
    const a = await exchange(sock, CONNECT('allowed.test'));
    const b = await exchange(sock, CONNECT('allowed.test'));
    const c = await exchange(sock, CONNECT('allowed.test'));
    expect([a.head, b.head].every((h) => h.startsWith('HTTP/1.1 200'))).toBe(true);
    expect(c.head).toMatch(/^HTTP\/1.1 429/);
    expect(audit.entries.find((e) => e.reason === 'limit')).toMatchObject({ decision: 'deny' });
    for (const x of [a, b, c]) x.socket.destroy();
  });

  it('ends a tunnel that passes the byte cap, and records it as limited', async () => {
    const sock = await start({ limits: { maxBytes: 100 } });
    const x = await exchange(sock, CONNECT('allowed.test'));
    x.socket.write('z'.repeat(500));
    await new Promise((r) => setTimeout(r, 200));
    expect(x.socket.destroyed || x.socket.readyState !== 'open').toBe(true);
    expect(audit.entries[0]).toMatchObject({ decision: 'allow', reason: 'limit' });
  });

  it('ends a tunnel that lives past its lifetime, even if it is busy', async () => {
    const sock = await start({ limits: { lifetimeMs: 250 } });
    const x = await exchange(sock, CONNECT('allowed.test'));
    const keepBusy = setInterval(() => {
      x.socket.write('ping');
    }, 40);
    await new Promise((r) => setTimeout(r, 500));
    clearInterval(keepBusy);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ decision: 'allow', reason: 'limit' });
    expect(audit.entries[0]?.duration_ms).toBeLessThan(450);
    x.socket.destroy();
  });

  it('ends an idle tunnel', async () => {
    const sock = await start({ limits: { idleMs: 150 } });
    const x = await exchange(sock, CONNECT('allowed.test'));
    expect(x.head).toMatch(/^HTTP\/1.1 200/);
    await new Promise((r) => setTimeout(r, 450));
    expect(audit.entries[0]).toMatchObject({ reason: 'limit' });
    x.socket.destroy();
  });

  it('close() records open tunnels, removes the socket, and refuses new connections', async () => {
    const sock = await start();
    const x = await exchange(sock, CONNECT('allowed.test'));
    x.socket.write('abc');
    await new Promise((r) => setTimeout(r, 100));
    await broker?.close();
    expect(existsSync(sock)).toBe(false);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ decision: 'allow', bytes_up: 3 });
    const refused = await new Promise<boolean>((resolve) => {
      const s = connect(sock);
      s.once('error', () => {
        resolve(true);
      });
      s.once('connect', () => {
        s.destroy();
        resolve(false);
      });
    });
    expect(refused).toBe(true);
  });
});
