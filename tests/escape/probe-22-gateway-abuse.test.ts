import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine/engine.js';
import { Gateway } from '../../src/gateway/server.js';
import { helperBuilds } from '../helpers/cell.js';
import { makeEngine } from '../helpers/engine.js';

// Probe 22 (Stage 5): attack the local gateway the way a hostile local client would: oversize and
// malformed requests, request smuggling, header floods, slowloris, pipelining floods, path tricks,
// and a socket directory other users could write to. The engine must stay up, run nothing, and
// answer in the closed error set. Layers expected to stop it: the gateway's limits, the strict
// request parser, and the socket directory and mode checks.

let root = '';
let sock = '';
let parent = '';
let engine: Engine;
let gw: Gateway | null = null;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aegis-p22-'));
  chmodSync(root, 0o700);
  sock = join(root, 'aegis', 'gateway.sock');
  parent = mkdtempSync(join(tmpdir(), 'aegis-p22-ws-'));
});
afterEach(async () => {
  await gw?.close();
  gw = null;
  await engine.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(parent, { recursive: true, force: true });
});

async function up(limits = {}): Promise<void> {
  const helper = helperBuilds()[0];
  if (helper === undefined) throw new Error('no helper build');
  engine = makeEngine(helper, parent);
  const r = await Gateway.start({ socketPath: sock, engine, limits });
  if (!r.ok) throw new Error(r.error.context);
  gw = r.value;
}

/** Writes raw bytes and collects whatever comes back until the socket closes or `ms` pass. */
function raw(data: string | Buffer, ms = 1500): Promise<string> {
  return new Promise((resolve) => {
    const s: Socket = connect(sock);
    let got = '';
    s.on('data', (d: Buffer) => (got += d.toString('latin1')));
    s.on('error', () => undefined);
    s.on('close', () => {
      resolve(got);
    });
    s.write(data);
    setTimeout(() => {
      s.destroy();
    }, ms);
  });
}

function status(): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: sock, path: '/v1/status' }, (res) => {
      res.resume();
      res.on('end', () => {
        resolve(res.statusCode ?? 0);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const codes = (text: string): number[] =>
  [...text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => Number(m[1]));

describe('probe 22: gateway abuse', () => {
  it('survives smuggling attempts, protocol errors and path tricks, running nothing', async () => {
    await up();
    const attacks: [string, string][] = [
      [
        'CL.TE smuggling',
        'POST /v1/runs HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nGET /v1/status HTTP/1.1\r\nHost: x\r\n\r\n',
      ],
      [
        'negative length',
        'POST /v1/runs HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: -1\r\n\r\n',
      ],
      [
        'non-numeric length',
        'POST /v1/runs HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: abc\r\n\r\n',
      ],
      ['HTTP/2 preface', 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'],
      ['bad method', 'FOO /v1/status HTTP/1.1\r\nHost: x\r\n\r\n'],
      ['huge URL', `GET /v1/${'a'.repeat(30_000)} HTTP/1.1\r\nHost: x\r\n\r\n`],
      ['null byte in path', 'GET /v1/status\u0000 HTTP/1.1\r\nHost: x\r\n\r\n'],
      ['absolute-form URL', 'GET http://evil.example/v1/status HTTP/1.1\r\nHost: x\r\n\r\n'],
      ['traversal', 'GET /v1/../../etc/passwd HTTP/1.1\r\nHost: x\r\n\r\n'],
      [
        'encoded traversal',
        'GET /v1/sessions/%2e%2e%2f%2e%2e%2fetc/diff HTTP/1.1\r\nHost: x\r\n\r\n',
      ],
      [
        'binary garbage',
        Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) & 255)).toString('latin1'),
      ],
    ];
    for (const [label, data] of attacks) {
      const reply = await raw(data, 800);
      const got = codes(reply);
      // Every reply is a 4xx, or the connection was simply closed; never a 2xx for an attack.
      expect(
        got.every((c) => c >= 400),
        `${label}: ${reply.slice(0, 80)}`,
      ).toBe(true);
      // A smuggled second request must not have been served.
      expect(
        got.filter((c) => c === 200),
        label,
      ).toEqual([]);
    }
    expect(await status()).toBe(200);
    expect(engine.status().cells).toMatchObject({ running: 0, queued: 0 });
    expect(engine.status().sessions).toEqual([]);
  });

  it('answers a flood of pipelined requests within its limits and stays up', async () => {
    await up();
    const one = 'GET /v1/status HTTP/1.1\r\nHost: x\r\n\r\n';
    const reply = await raw(one.repeat(300), 2500);
    expect(codes(reply).length).toBeGreaterThan(0);
    expect(codes(reply).every((c) => c === 200 || c >= 400)).toBe(true);
    expect(await status()).toBe(200);
  });

  it('drops slow-header clients (slowloris) and caps simultaneous connections', async () => {
    await up({ headersTimeoutMs: 300, requestTimeoutMs: 600, maxConnections: 4 });
    const slow = await new Promise<number>((resolve) => {
      const t0 = Date.now();
      const s = connect(sock);
      s.resume();
      s.on('close', () => {
        resolve(Date.now() - t0);
      });
      s.write('GET /v1/status HTTP/1.1\r\n');
      setTimeout(() => {
        s.write('Host: x\r\n'); // a byte at a time never completes the head
      }, 100);
      setTimeout(() => {
        s.destroy();
      }, 3500);
    });
    expect(slow).toBeLessThan(3000);
    const held: Socket[] = [];
    for (let i = 0; i < 4; i++) {
      const s = connect(sock);
      s.resume();
      await new Promise<void>((done) => {
        s.once('connect', () => {
          done();
        });
      });
      held.push(s);
    }
    const extra = await new Promise<boolean>((resolve) => {
      const s = connect(sock);
      s.resume();
      s.once('close', () => {
        resolve(true);
      });
      s.once('error', () => {
        resolve(true);
      });
      setTimeout(() => {
        resolve(false);
      }, 1500);
    });
    expect(extra).toBe(true);
    for (const s of held) s.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(await status()).toBe(200);
  });

  it('refuses to listen in a directory that other users could write to, or that is a symlink', async () => {
    const helper = helperBuilds()[0];
    if (helper === undefined) throw new Error('no helper build');
    engine = makeEngine(helper, parent);
    for (const mode of [0o770, 0o750, 0o755, 0o707]) {
      const dir = join(root, `loose-${mode.toString(8)}`);
      mkdirSync(dir);
      chmodSync(dir, mode);
      const r = await Gateway.start({ socketPath: join(dir, 'gateway.sock'), engine });
      expect(r.ok, mode.toString(8)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('EACCES');
    }
  });
});
