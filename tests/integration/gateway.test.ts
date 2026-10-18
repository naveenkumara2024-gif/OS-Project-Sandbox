import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine/engine.js';
import { Gateway, codeFor, defaultSocketPath } from '../../src/gateway/server.js';
import { readFileSync } from 'node:fs';
import { createFixture, type Fixture } from '../escape/harness.js';
import { helperBuilds } from '../helpers/cell.js';
import { makeEngine, testPolicy } from '../helpers/engine.js';

let root = '';
let sock = '';
let parent = '';
let fixture: Fixture;
let engine: Engine;
let gw: Gateway | null = null;
beforeEach(() => {
  fixture = createFixture();
  root = mkdtempSync(join(tmpdir(), 'aegis-gw-'));
  chmodSync(root, 0o700);
  sock = join(root, 'aegis', 'gateway.sock');
  parent = mkdtempSync(join(tmpdir(), 'aegis-gw-ws-'));
});
afterEach(async () => {
  await gw?.close();
  gw = null;
  await engine.close();
  fixture.dispose();
  rmSync(root, { recursive: true, force: true });
  rmSync(parent, { recursive: true, force: true });
});

interface Reply {
  status: number;
  text: string;
  json: unknown;
}

function call(
  method: string,
  path: string,
  body?: string | Buffer,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: sock, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const postJson = (path: string, obj: unknown): Promise<Reply> =>
  call('POST', path, JSON.stringify(obj), { 'content-type': 'application/json' });

async function startGateway(
  helperIdx: number,
  limits: Partial<ConstructorParameters<typeof Object>[0]> = {},
  policyOver: Parameters<typeof testPolicy>[0] = {},
): Promise<void> {
  const helper = helperBuilds()[helperIdx];
  if (helper === undefined) throw new Error('no helper');
  engine = makeEngine(helper, parent, {
    policy: testPolicy({ ingestRoots: [fixture.project], ...policyOver }),
  });
  const started = await Gateway.start({ socketPath: sock, engine, limits });
  if (!started.ok) throw new Error(`gateway: ${started.error.code} ${started.error.context}`);
  gw = started.value;
}

describe.each(helperBuilds().map((h, i) => [h.name, i] as const))(
  'gateway full session ($0 build)',
  (_name, idx) => {
    it('runs, streams NDJSON, shows the diff, refuses a stale commit, commits, discards', async () => {
      await startGateway(idx);
      const created = await postJson('/v1/runs', {
        command: ['/usr/bin/sh', '-c', 'echo first; sleep 0.2; echo second > out.txt; echo done'],
        workspace: { source: fixture.project },
        files: [{ path: 'seed.txt', content: 'x' }],
      });
      expect(created.status).toBe(202);
      const { run, session } = created.json as { run: string; session: string };
      expect(run).toMatch(/^r-[0-9a-f]{32}$/);
      expect(session).toMatch(/^s-[0-9a-f]{32}$/);

      const events = await call('GET', `/v1/runs/${run}/events`);
      expect(events.status).toBe(200);
      const lines = events.text.trim().split('\n');
      const parsed = lines.map((l) => JSON.parse(l) as { type: string; seq: number });
      expect(parsed[0]?.type).toBe('started');
      expect(parsed[parsed.length - 1]?.type).toBe('receipt');
      expect(parsed.map((e) => e.seq)).toEqual([...parsed.map((e) => e.seq)].sort((a, b) => a - b));

      const state = await call('GET', `/v1/runs/${run}`);
      const body = state.json as {
        state: string;
        receipt: { stdout: string; isolation: { level: number } };
      };
      expect(body.state).toBe('done');
      expect(body.receipt.stdout).toBe('first\ndone\n');
      expect(body.receipt.isolation.level).toBe(4);

      const diff = await call('GET', `/v1/sessions/${session}/diff`);
      expect(diff.status).toBe(200);
      const d = diff.json as { changes: { path: string }[]; changes_sha256: string };
      expect(d.changes.map((c) => c.path)).toEqual(['out.txt']);

      const stale = await postJson(`/v1/sessions/${session}/commit`, {
        paths: ['out.txt'],
        expected_changes_sha256: 'f'.repeat(64),
      });
      expect(stale.status).toBe(409);
      expect(stale.json).toMatchObject({
        error: { code: 'stale_diff' },
        diff: { changes_sha256: d.changes_sha256 },
      });
      expect(existsSync(join(fixture.project, 'out.txt'))).toBe(false);

      const done = await postJson(`/v1/sessions/${session}/commit`, {
        paths: ['out.txt'],
        expected_changes_sha256: d.changes_sha256,
      });
      expect(done.status).toBe(200);
      expect(readFileSync(join(fixture.project, 'out.txt'), 'utf8')).toBe('second\n');

      expect((await call('DELETE', `/v1/sessions/${session}`)).status).toBe(200);
      expect((await call('GET', `/v1/sessions/${session}/diff`)).status).toBe(404);
      const status = await call('GET', '/v1/status');
      expect(status.json).toMatchObject({ sessions: [] });
    });

    it('cancels a running run', async () => {
      await startGateway(idx);
      const created = await postJson('/v1/runs', { command: ['/usr/bin/sleep', '30'] });
      const { run } = created.json as { run: string };
      await new Promise((r) => setTimeout(r, 400));
      expect((await call('POST', `/v1/runs/${run}/cancel`)).status).toBe(202);
      const deadline = Date.now() + 5000;
      let state = '';
      let cause = '';
      while (Date.now() < deadline) {
        const r = (await call('GET', `/v1/runs/${run}`)).json as {
          state: string;
          receipt?: { termination: { cause: string } };
        };
        state = r.state;
        cause = r.receipt?.termination.cause ?? '';
        if (state === 'done') break;
        await new Promise((r2) => setTimeout(r2, 50));
      }
      expect(state).toBe('done');
      expect(cause).toBe('cancelled');
      expect((await call('POST', `/v1/runs/${run}/cancel`)).status).toBe(404);
    });

    it('a second run in a running session is refused with 409 busy', async () => {
      await startGateway(idx);
      const first = await postJson('/v1/runs', {
        command: ['/usr/bin/sleep', '1'],
        files: [{ path: 'a', content: 'x' }],
      });
      const { session } = first.json as { session: string };
      const second = await postJson('/v1/runs', { command: ['/usr/bin/true'], session });
      expect(second.status).toBe(409);
      expect(second.json).toMatchObject({ error: { code: 'busy' } });
    });
  },
);

describe('gateway socket and directory', () => {
  it('creates the directory 0700 and the socket 0600, with no TCP listener', async () => {
    await startGateway(0);
    expect(lstatSync(sock).isSocket()).toBe(true);
    expect(lstatSync(sock).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(root, 'aegis')).mode & 0o777).toBe(0o700);
    const ss = spawnSync('ss', ['-ltnp'], { encoding: 'utf8' });
    expect(ss.stdout).not.toMatch(new RegExp(`pid=${String(process.pid)},`));
  });

  it('refuses to start in a directory other users could use', async () => {
    mkdirSync(join(root, 'aegis'), { mode: 0o755 });
    chmodSync(join(root, 'aegis'), 0o755);
    const helper = helperBuilds()[0];
    if (helper === undefined) throw new Error('no helper build');
    engine = makeEngine(helper, parent);
    const r = await Gateway.start({ socketPath: sock, engine });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('EACCES');
  });

  it('replaces a stale socket but never one that is live', async () => {
    mkdirSync(join(root, 'aegis'), { mode: 0o700 });
    const py = spawnSync(
      'python3',
      ['-c', `import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])`, sock],
      { encoding: 'utf8' },
    );
    expect(py.status).toBe(0);
    expect(lstatSync(sock).isSocket()).toBe(true); // left behind, nobody listening
    await startGateway(0);
    expect((await call('GET', '/v1/status')).status).toBe(200);
    const second = await Gateway.start({ socketPath: sock, engine });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('EADDRINUSE');
    expect((await call('GET', '/v1/status')).status).toBe(200); // the first one is unharmed
  });

  it('says so when the socket path is too long for a Unix socket', async () => {
    const helper = helperBuilds()[0];
    if (helper === undefined) throw new Error('no helper build');
    engine = makeEngine(helper, parent);
    const r = await Gateway.start({
      socketPath: join(root, 'a'.repeat(100), 'gateway.sock'),
      engine,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ENAMETOOLONG');
  });

  it('needs XDG_RUNTIME_DIR and does not fall back to a shared directory', () => {
    expect(defaultSocketPath({}).ok).toBe(false);
    expect(defaultSocketPath({ XDG_RUNTIME_DIR: 'relative' }).ok).toBe(false);
    const ok = defaultSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' });
    expect(ok.ok && ok.value).toBe('/run/user/1000/aegis/gateway.sock');
  });
});

describe('gateway limits and abuse', () => {
  it('rejects an oversize Content-Length, an oversize chunked body, and bad bodies', async () => {
    await startGateway(0, { maxBodyBytes: 1024 });
    const big = await call('POST', '/v1/runs', 'x'.repeat(4096), {
      'content-type': 'application/json',
    });
    expect(big.status).toBe(413);
    // chunked: no Content-Length, body streamed past the cap
    const chunked = await new Promise<number>((resolve) => {
      const req = httpRequest(
        {
          socketPath: sock,
          method: 'POST',
          path: '/v1/runs',
          headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        },
      );
      req.on('error', () => {
        resolve(-1);
      });
      for (let i = 0; i < 8; i++) req.write('y'.repeat(512));
      req.end();
    });
    expect([413, -1]).toContain(chunked);
    expect((await postJson('/v1/runs', { command: 'not-an-array' })).status).toBe(400);
    expect(
      (
        await call('POST', '/v1/runs', '{"command":["/usr/bin/true"]}', {
          'content-type': 'text/plain',
        })
      ).status,
    ).toBe(405);
    expect(
      (await call('POST', '/v1/runs', '', { 'content-type': 'application/json' })).status,
    ).toBe(400);
    expect((await call('GET', '/v1/status')).status).toBe(200); // still up
  });

  it('never echoes request content in an error', async () => {
    await startGateway(0);
    const r = await call('POST', '/v1/runs', '{"command":["/usr/bin/true"],"SECRETXYZ":1}', {
      'content-type': 'application/json',
    });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain('SECRETXYZ');
    const r2 = await call('POST', '/v1/runs', '{"__proto__": {"SECRETXYZ": 1}', {
      'content-type': 'application/json',
    });
    expect(r2.text).not.toContain('SECRETXYZ');
  });

  it('rejects unknown paths, wrong methods, bad ids, traversal and escapes', async () => {
    await startGateway(0);
    expect((await call('GET', '/')).status).toBe(404);
    expect((await call('GET', '/v2/status')).status).toBe(404);
    expect((await call('POST', '/v1/status')).status).toBe(405);
    expect((await call('GET', '/v1/runs')).status).toBe(405);
    for (const bad of [
      '/v1/runs/not-an-id',
      '/v1/runs/r-xyz/events',
      '/v1/sessions/..%2f..%2fetc/diff',
      '/v1/sessions/s-../diff',
      '/v1/sessions//diff',
      '/v1/sessions/s-' + '0'.repeat(32) + '/../../etc',
      '/v1/runs/' + 'r-' + 'g'.repeat(32),
    ]) {
      const r = await call('GET', bad);
      expect(r.status, bad).toBe(404);
    }
    expect((await call('GET', `/v1/sessions/s-${'0'.repeat(32)}/diff`)).status).toBe(404);
    expect((await call('PUT', `/v1/sessions/s-${'0'.repeat(32)}`)).status).toBe(405);
    // a CLI-style id is not accepted on the gateway
    expect((await call('GET', '/v1/sessions/my-run/diff')).status).toBe(404);
    expect(
      (await postJson('/v1/runs', { command: ['/usr/bin/true'], session: 'my-run' })).status,
    ).toBe(400);
  });

  it('refuses a request with too many headers or oversized headers, and stays up', async () => {
    await startGateway(0, { maxHeaders: 8 });
    const many: Record<string, string> = {};
    for (let i = 0; i < 20; i++) many[`x-h${String(i)}`] = 'v';
    expect((await call('GET', '/v1/status', undefined, many)).status).toBe(400);
    const flood = await new Promise<string>((resolve) => {
      const s: Socket = connect(sock);
      let got = '';
      s.on('data', (d: Buffer) => (got += d.toString('latin1')));
      s.on('close', () => {
        resolve(got);
      });
      s.write(`GET /v1/status HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(40_000)}\r\n\r\n`);
      setTimeout(() => {
        s.destroy();
      }, 1500);
    });
    expect(flood).toMatch(/^HTTP\/1.1 (400|431)/);
    expect((await call('GET', '/v1/status')).status).toBe(200);
  });

  it('drops a client that sends its headers too slowly', async () => {
    await startGateway(0, { headersTimeoutMs: 300, requestTimeoutMs: 600 });
    const closedAfter = await new Promise<number>((resolve) => {
      const t0 = Date.now();
      const s: Socket = connect(sock);
      s.resume(); // an unread socket never notices the server closing it
      s.on('close', () => {
        resolve(Date.now() - t0);
      });
      s.write('GET /v1/status HTTP/1.1\r\nHost: x\r\n'); // never finishes the headers
      setTimeout(() => {
        s.destroy();
      }, 4000);
    });
    expect(closedAfter).toBeLessThan(3500);
    expect((await call('GET', '/v1/status')).status).toBe(200);
  });

  it('caps the number of simultaneous connections', async () => {
    await startGateway(0, { maxConnections: 3 });
    const socks: Socket[] = [];
    for (let i = 0; i < 3; i++) {
      const s = connect(sock);
      await new Promise<void>((done) => {
        s.once('connect', () => {
          done();
        });
      });
      socks.push(s);
    }
    const extra = connect(sock);
    const closed = await new Promise<boolean>((resolve) => {
      extra.once('close', () => {
        resolve(true);
      });
      extra.once('error', () => {
        resolve(true);
      });
      setTimeout(() => {
        resolve(false);
      }, 1500);
    });
    expect(closed).toBe(true);
    for (const s of socks) s.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect((await call('GET', '/v1/status')).status).toBe(200);
  });
});

describe('error code mapping', () => {
  it('maps engine codes to the closed set', () => {
    expect(codeFor('EINVAL')).toBe('invalid_request');
    expect(codeFor('ENOENT')).toBe('not_found');
    expect(codeFor('EBUSY')).toBe('busy');
    expect(codeFor('E2BIG')).toBe('too_large');
    expect(codeFor('EACCES')).toBe('policy');
    expect(codeFor('ESHUTDOWN')).toBe('shutting_down');
    expect(codeFor('SOMETHING')).toBe('internal');
  });
});
