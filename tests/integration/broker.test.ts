import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttps, type Server } from 'node:https';
import { connect, createServer as createTcp, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Dialer, Resolver } from '../../src/broker/broker.js';
import {
  helperBuilds,
  request,
  runWith,
  testGovernance,
  type HelperBuild,
} from '../helpers/cell.js';

// A brokered cell, end to end: no interface but loopback, a forwarder in the cell, and the broker
// on the host. DNS and dialing are stubbed so the "internet" is a local TLS server; the policy
// code that decides is the real thing.

const PUBLIC = '93.184.216.34';
const NAMES: Record<string, string[]> = {
  'allowed.test': [PUBLIC],
  'internal.test': ['169.254.169.254'],
  'rebind.test': [PUBLIC, '10.0.0.5'],
};
const resolver: Resolver = (host) => {
  const ips = NAMES[host];
  return ips === undefined ? Promise.reject(new Error('NXDOMAIN')) : Promise.resolve(ips);
};

let tmp = '';
let https: Server;
let httpsPort = 0;
let decoy: TcpServer;
let decoyPort = 0;
let decoyHits = 0;
let dials: string[] = [];
const dial: Dialer = (ip, port) => {
  dials.push(`${ip}:${String(port)}`);
  if (ip !== PUBLIC || port !== 443) return Promise.reject(new Error('unreachable'));
  return new Promise((resolve, reject) => {
    const s = connect(httpsPort, '127.0.0.1');
    s.once('connect', () => {
      resolve(s);
    });
    s.once('error', reject);
  });
};

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'aegis-brokered-'));
  const gen = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(tmp, 'k.pem'),
      '-out',
      join(tmp, 'c.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=allowed.test',
    ],
    { encoding: 'utf8' },
  );
  if (gen.status !== 0) throw new Error(`openssl failed: ${gen.stderr}`);
  https = createHttps(
    { key: readFileSync(join(tmp, 'k.pem')), cert: readFileSync(join(tmp, 'c.pem')) },
    (_req, res) => {
      res.end('hello from the allowed host\n');
    },
  );
  await new Promise<void>((r) => https.listen(0, '127.0.0.1', r));
  const a = https.address();
  httpsPort = typeof a === 'object' && a !== null ? a.port : 0;
  // Something on the host's loopback that a cell must never be able to reach directly.
  decoy = createTcp((s) => {
    decoyHits++;
    s.end('decoy\n');
  });
  await new Promise<void>((r) => decoy.listen(0, '127.0.0.1', r));
  const d = decoy.address();
  decoyPort = typeof d === 'object' && d !== null ? d.port : 0;
});
afterAll(async () => {
  await new Promise<void>((r) =>
    https.close(() => {
      r();
    }),
  );
  await new Promise<void>((r) =>
    decoy.close(() => {
      r();
    }),
  );
  rmSync(tmp, { recursive: true, force: true });
});

const gov = () =>
  testGovernance({ networkAllow: ['allowed.test', 'internal.test', 'rebind.test'] });
const brokered = (command: string[], allow: string[] = ['allowed.test']) =>
  request(command, { manifest: { network: { mode: 'brokered', allow } } });

async function run(helper: HelperBuild, command: string[], allow?: string[]) {
  dials = [];
  return runWith(helper, brokered(command, allow), {
    governance: gov(),
    broker: { resolver, dial },
  });
}

describe.each(helperBuilds())('brokered cell ($name build)', (helper) => {
  it('reaches an allowlisted host through the proxy with curl, and audits it', async () => {
    const r = await run(helper, [
      '/usr/bin/curl',
      '-sSk',
      '--max-time',
      '10',
      'https://allowed.test/',
    ]);
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    expect(r.stdout).toBe('hello from the allowed host\n');
    expect(r.network.mode).toBe('brokered');
    expect(r.network.egress).toBe(true);
    expect(r.isolation.layers.loopback).toBe(true);
    expect(r.isolation.layers.broker).toBe(true);
    expect(r.isolation.level).toBeGreaterThanOrEqual(2);
    const audit = r.network.audit ?? [];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      host: 'allowed.test',
      port: 443,
      decision: 'allow',
      resolved: PUBLIC,
    });
    expect(audit[0]?.bytes_up).toBeGreaterThan(0);
    expect(audit[0]?.bytes_down).toBeGreaterThan(0);
    expect(dials).toEqual([`${PUBLIC}:443`]);
  });

  it('works for Python urllib too (it reads the proxy variables)', async () => {
    const script = [
      'import ssl, urllib.request',
      'ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE',
      'print(urllib.request.urlopen("https://allowed.test/", context=ctx, timeout=10).read().decode().strip())',
    ].join('\n');
    const r = await run(helper, ['/usr/bin/python3', '-c', script]);
    expect(r.stdout.trim()).toBe('hello from the allowed host');
  });

  it('sets the proxy variables, leaves the rest of the environment explicit, and refuses a request that tries to override them', async () => {
    const r = await run(helper, ['/usr/bin/env']);
    const lines = r.stdout
      .split('\n')
      .filter((l) => l !== '')
      .sort();
    expect(lines).toEqual([
      'HTTPS_PROXY=http://127.0.0.1:3128',
      'HTTP_PROXY=http://127.0.0.1:3128',
      'PATH=/usr/bin:/bin',
      'http_proxy=http://127.0.0.1:3128',
      'https_proxy=http://127.0.0.1:3128',
    ]);
    const { parseRunRequest } = await import('../../src/gateway/request.js');
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
      const p = parseRunRequest(
        JSON.stringify({ command: ['/usr/bin/true'], env: { [name]: 'http://evil.example' } }),
      );
      expect(p.ok, name).toBe(false);
    }
  });

  it('answers 403 and audits an unlisted host; the target is never dialed', async () => {
    const r = await run(helper, [
      '/usr/bin/curl',
      '-sS',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '--max-time',
      '10',
      'https://evil.example/',
    ]);
    expect(r.stdout).toBe('000'); // the CONNECT was refused, so there is no HTTP response
    expect(r.stderr).toMatch(/403|CONNECT/);
    expect(r.network.audit).toEqual([
      expect.objectContaining({
        host: 'evil.example',
        decision: 'deny',
        reason: 'not_allowlisted',
      }),
    ]);
    expect(dials).toEqual([]);
  });

  it('refuses a name that resolves to an internal address, and a rebinding name, and never dials', async () => {
    for (const host of ['internal.test', 'rebind.test']) {
      const r = await run(
        helper,
        ['/usr/bin/curl', '-sS', '-o', '/dev/null', '--max-time', '10', `https://${host}/`],
        [host],
      );
      expect(r.network.audit?.[0], host).toMatchObject({
        host,
        decision: 'deny',
        reason: 'private_address',
      });
    }
    expect(dials).toEqual([]);
  });

  it('refuses other ports (only 443 is allowed)', async () => {
    const r = await run(helper, [
      '/usr/bin/curl',
      '-sS',
      '-o',
      '/dev/null',
      '--max-time',
      '10',
      'https://allowed.test:8443/',
    ]);
    expect(r.network.audit?.[0]).toMatchObject({ port: 8443, reason: 'port_not_allowed' });
    expect(dials).toEqual([]);
  });

  it('a program that ignores the proxy variables cannot connect anywhere', async () => {
    const script = [
      'import socket',
      'def t(label, host, port):',
      '    s = socket.socket(); s.settimeout(3)',
      '    try:',
      '        s.connect((host, port)); print(label, "CONNECTED")',
      '    except OSError as e:',
      '        print(label, "denied", e.errno)',
      't("internet", "93.184.216.34", 443)',
      't("cloudflare", "1.1.1.1", 443)',
      `t("host-loopback-decoy", "127.0.0.1", ${String(decoyPort)})`,
      't("other-loopback-port", "127.0.0.1", 8080)',
      'l = socket.socket()',
      'try:',
      '    l.bind(("127.0.0.1", 3129)); print("bind CONNECTED")',
      'except OSError as e:',
      '    print("bind denied", e.errno)',
    ].join('\n');
    const r = await run(helper, ['/usr/bin/python3', '-c', script]);
    expect(r.stdout).not.toContain('CONNECTED');
    expect(r.stdout.match(/denied/g)?.length).toBe(5);
    // EACCES (13) is Landlock's answer. Without its port rule, a free loopback port would answer
    // ECONNREFUSED (111) and a bind would succeed, so these pin down which layer is doing it.
    expect(r.stdout).toContain('other-loopback-port denied 13');
    expect(r.stdout).toContain('bind denied 13');
    expect(decoyHits).toBe(0);
    expect(r.network.audit).toEqual([]); // nothing reached the broker
  });

  it('has loopback and no other interface, and no route', async () => {
    const r = await run(helper, [
      '/usr/bin/sh',
      '-c',
      'tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d " "; echo ROUTES:; tail -n +2 /proc/net/route | wc -l',
    ]);
    expect(r.stdout).toBe('lo\nROUTES:\n0\n');
  });

  it('an air-gapped run has none of this: no loopback, no broker, no proxy variables', async () => {
    const r = await runWith(helper, request(['/usr/bin/env']), { governance: gov() });
    expect(r.stdout).toBe('PATH=/usr/bin:/bin\n');
    expect(r.isolation.layers.loopback).toBe(false);
    expect(r.isolation.layers.broker).toBe(false);
    expect(r.network).toEqual({ mode: 'none', egress: false });
  });

  it('a brokered request with nothing on the ceiling allowlist is resolved to an air-gapped cell', async () => {
    const r = await runWith(helper, brokered(['/usr/bin/true'], ['allowed.test']), {
      governance: testGovernance({ networkAllow: [] }),
    });
    expect(r.manifest.network).toEqual({ mode: 'none', allow: [] });
    expect(r.network).toEqual({ mode: 'none', egress: false });
    expect(r.clamped).toContainEqual({
      field: 'network.mode',
      requested: 'brokered',
      granted: 'none',
    });
  });

  it('a manifest can require the broker layers; an air-gapped run that requires them is refused', async () => {
    const refused = await runWith(
      helper,
      request(['/usr/bin/sh', '-c', 'echo RAN'], { manifest: { require: ['broker'] } }),
      { governance: gov() },
    );
    // The air-gapped cell never started the forwarder, so the second check refuses it.
    expect(refused.termination).toMatchObject({ cause: 'isolation_unavailable', layer: 'broker' });
    expect(refused.stdout).not.toContain('RAN');
    const ok1 = await run(helper, ['/usr/bin/true']);
    expect(ok1.termination).toEqual({ cause: 'exit' });
  });

  it('leaves no broker socket or cell directory behind', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'aegis-leftover-'));
    try {
      dials = [];
      const r = await runWith(helper, brokered(['/usr/bin/true']), {
        governance: gov(),
        broker: { resolver, dial },
        tmpParent: parent,
      });
      expect(r.termination).toEqual({ cause: 'exit' });
      const { readdirSync } = await import('node:fs');
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
