import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { snapshotTree, createFixture, type Fixture } from '../escape/harness.js';
import { McpClient } from '../e2e/mcp-client.js';
import { helperBuilds } from '../helpers/cell.js';

// The end-to-end gate (prompt Stage 5 section 8): a scripted MCP client plays a complete harness
// session against the real `aegis mcp` process and real cells. It stands in for an AI harness:
// it runs code, reads the structured result, repairs the program, reads the diff, and a commit
// lands only for the approved paths and only for the diff that was shown.

let work = '';
let fixture: Fixture;
let env: NodeJS.ProcessEnv;
const root = join(import.meta.dirname, '..', '..');

beforeAll(() => {
  fixture = createFixture();
  work = mkdtempSync(join(tmpdir(), 'aegis-mcp-'));
  for (const d of ['run', 'state', 'tmp']) mkdirSync(join(work, d), { mode: 0o700 });
  chmodSync(join(work, 'run'), 0o700);
  const base = JSON.parse(readFileSync(join(root, 'policy.default.json'), 'utf8')) as object;
  const policyFile = join(work, 'policy.json');
  writeFileSync(
    policyFile,
    JSON.stringify({ ...base, ingest_roots: [fixture.project], ingest_excludes: [] }),
  );
  env = {
    PATH: process.env['PATH'] ?? '',
    HOME: work,
    TMPDIR: join(work, 'tmp'),
    XDG_RUNTIME_DIR: join(work, 'run'),
    XDG_STATE_HOME: join(work, 'state'),
    AEGIS_POLICY_FILE: policyFile,
    AEGIS_CELL_BIN: helperBuilds()[0]?.path ?? '',
  };
});
afterAll(() => {
  fixture.dispose();
  rmSync(work, { recursive: true, force: true });
});

const meta = (v = '2026-07-28') => ({
  'io.modelcontextprotocol/protocolVersion': v,
  'io.modelcontextprotocol/clientInfo': { name: 'scripted', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
});

describe('a harness session over MCP (legacy handshake)', () => {
  it('runs code, repairs it, reads the diff, and commits only the approved paths', async () => {
    const before = snapshotTree(fixture.project);
    const c = new McpClient(env);
    try {
      const init = await c.call('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'scripted', version: '1' },
      });
      expect(init.result).toMatchObject({
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'aegis' },
      });
      c.notify('notifications/initialized');

      const list = await c.call('tools/list');
      const names = (list.result?.['tools'] as { name: string }[]).map((t) => t.name);
      expect(names).toEqual(['run', 'status', 'diff', 'commit', 'discard']);

      // 1. The first attempt is broken. The failure is data, not an error.
      const r1 = await c.tool('run', {
        command: ['/usr/bin/python3', 'analyze.py'],
        workspace: { source: fixture.project },
        files: [{ path: 'analyze.py', content: 'print(sum(range(10))\n' }], // missing paren
      });
      expect(r1.isError).toBeUndefined();
      expect(r1.structuredContent).toMatchObject({ termination: { cause: 'exit' } });
      expect(r1.structuredContent['exit_code']).not.toBe(0);
      expect(String(r1.structuredContent['stderr'])).toContain('SyntaxError');
      const session = r1.structuredContent['session'] as string;
      expect(session).toMatch(/^s-[0-9a-f]{32}$/);
      const iso = r1.structuredContent['isolation'] as { level: number };
      expect(iso.level).toBe(4);
      expect(r1.structuredContent['manifest_sha256']).toMatch(/^[0-9a-f]{64}$/);

      // 2. Repair and re-run in the same session.
      const r2 = await c.tool('run', {
        session,
        command: ['/usr/bin/python3', 'analyze.py'],
        files: [{ path: 'analyze.py', content: 'print(sum(range(10)))\n' }],
      });
      expect(r2.structuredContent['stdout']).toBe('45\n');

      // 3. Produce an output file, and also plant things that must never be committed.
      const r3 = await c.tool('run', {
        session,
        command: [
          '/usr/bin/sh',
          '-c',
          'python3 analyze.py > report.csv; ln -s /etc/passwd leak.txt; mkdir -p .git/hooks; echo x > .git/hooks/post-checkout',
        ],
      });
      expect(r3.structuredContent['termination']).toEqual({ cause: 'exit' });

      // 4. Review.
      const d = await c.tool('diff', { session });
      const diff = d.structuredContent as {
        changes: { path: string; op: string }[];
        changes_sha256: string;
        source: string;
      };
      expect(diff.changes.map((x) => x.path).sort()).toEqual([
        '.git/hooks/post-checkout',
        'analyze.py',
        'leak.txt',
        'report.csv',
      ]);
      expect(diff.source).toBe(fixture.project);

      // 5. Nothing has reached the project yet.
      expect(snapshotTree(fixture.project)).toEqual(before);

      // 6. A stale hash is refused, with the current diff, and nothing is written.
      const stale = await c.tool('commit', {
        session,
        paths: ['analyze.py', 'report.csv'],
        expected_changes_sha256: 'e'.repeat(64),
      });
      expect(stale.isError).toBe(true);
      expect(stale.structuredContent).toMatchObject({
        error: { code: 'stale_diff' },
        diff: { changes_sha256: diff.changes_sha256 },
      });
      expect(snapshotTree(fixture.project)).toEqual(before);

      // 7. The approved paths, with the hash that was reviewed.
      const done = await c.tool('commit', {
        session,
        paths: ['analyze.py', 'report.csv', 'leak.txt', '.git/hooks/post-checkout'],
        expected_changes_sha256: diff.changes_sha256,
      });
      expect(done.isError).toBeUndefined();
      const outcomes = new Map(
        (done.structuredContent['outcomes'] as { path: string; status: string }[]).map((o) => [
          o.path,
          o.status,
        ]),
      );
      expect(outcomes.get('analyze.py')).toBe('committed');
      expect(outcomes.get('report.csv')).toBe('committed');
      expect(outcomes.get('leak.txt')).toBe('refused');
      expect(outcomes.get('.git/hooks/post-checkout')).toBe('refused');

      // 8. The project on disk, byte for byte.
      expect(readFileSync(join(fixture.project, 'analyze.py'), 'utf8')).toBe(
        'print(sum(range(10)))\n',
      );
      expect(readFileSync(join(fixture.project, 'report.csv'), 'utf8')).toBe('45\n');
      expect(existsSync(join(fixture.project, 'leak.txt'))).toBe(false);
      expect(existsSync(join(fixture.project, '.git'))).toBe(false);
      expect(readFileSync(join(fixture.project, 'README.md'), 'utf8')).toBe(
        '# sacrificial project\n',
      );

      // 9. Done: discard, then the session is gone.
      const gone = await c.tool('discard', { session });
      expect(gone.structuredContent).toEqual({ session, discarded: true });
      const after = await c.tool('diff', { session });
      expect(after.isError).toBe(true);
      expect(after.structuredContent).toMatchObject({ error: { code: 'not_found' } });

      // Every line on stdout was a JSON-RPC message; nothing else was ever written there.
      // One reply per request (ten requests), and no unsolicited messages.
      expect(c.lines.length).toBe(10);
      for (const l of c.lines) expect(JSON.parse(l)).toMatchObject({ jsonrpc: '2.0' });
    } finally {
      expect(await c.close()).toBe(0);
    }
  });
});

describe('a harness session over MCP (modern, stateless)', () => {
  it('discovers, lists tools and runs a command with per-request metadata', async () => {
    const c = new McpClient(env);
    try {
      const disc = await c.call('server/discover', { _meta: meta() });
      expect(disc.result).toMatchObject({
        resultType: 'complete',
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
      });
      const list = await c.call('tools/list', { _meta: meta() });
      expect((list.result?.['tools'] as unknown[]).length).toBe(5);
      const run = await c.call('tools/call', {
        name: 'run',
        arguments: { command: ['/usr/bin/echo', 'modern'] },
        _meta: meta(),
      });
      expect(run.result).toMatchObject({
        resultType: 'complete',
        structuredContent: { stdout: 'modern\n', termination: { cause: 'exit' } },
      });
      const bad = await c.call('tools/list', { _meta: meta('2099-01-01') });
      expect(bad.error).toMatchObject({ code: -32022 });
    } finally {
      expect(await c.close()).toBe(0);
    }
  });
});

describe('MCP robustness', () => {
  it('survives garbage, a huge line and unknown requests, and keeps stdout clean', async () => {
    const c = new McpClient(env);
    try {
      c.raw('{ this is not json');
      c.raw('x'.repeat(1_200_000));
      c.raw({ jsonrpc: '2.0', id: 'x', method: 'no/such/method' });
      const ping = await c.call('ping');
      expect(ping.result).toEqual({});
      await new Promise((r) => setTimeout(r, 200));
      const msgs = c.lines.map((l) => JSON.parse(l) as { id: unknown; error?: { code: number } });
      expect(msgs.some((m) => m.id === null && m.error?.code === -32700)).toBe(true);
      expect(msgs.some((m) => m.id === null && m.error?.code === -32600)).toBe(true);
      expect(msgs.some((m) => m.id === 'x' && m.error?.code === -32601)).toBe(true);
    } finally {
      expect(await c.close()).toBe(0);
    }
  });

  it('cancelling a running call stops the cell and sends no reply for it', async () => {
    const c = new McpClient(env);
    try {
      const { id, reply } = c.request('tools/call', {
        name: 'run',
        arguments: { command: ['/usr/bin/sleep', '30'] },
      });
      let replied = false;
      void reply.then(() => {
        replied = true;
      });
      await new Promise((r) => setTimeout(r, 800));
      const status1 = await c.tool('status', {});
      expect((status1.structuredContent['cells'] as { running: number }).running).toBe(1);
      c.notify('notifications/cancelled', { requestId: id });
      const deadline = Date.now() + 6000;
      let running = 1;
      while (running !== 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        const s = await c.tool('status', {});
        running = (s.structuredContent['cells'] as { running: number }).running;
      }
      expect(running).toBe(0);
      await new Promise((r) => setTimeout(r, 300));
      expect(replied).toBe(false);
      expect(c.lines.some((l) => (JSON.parse(l) as { id: unknown }).id === id)).toBe(false);
      reply.catch(() => undefined);
    } finally {
      expect(await c.close()).toBe(0);
    }
  });

  it('closing stdin while a call is running cancels it and exits cleanly', async () => {
    const c = new McpClient(env);
    const t0 = Date.now();
    c.raw({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'run', arguments: { command: ['/usr/bin/sleep', '30'] } },
    });
    await new Promise((r) => setTimeout(r, 800));
    expect(await c.close()).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('refuses to start without a valid policy, saying why on stderr and nothing on stdout', async () => {
    const c = new McpClient({ ...env, AEGIS_POLICY_FILE: join(work, 'missing.json') });
    expect(await c.exited).toBe(65);
    expect(c.stderr).toMatch(/policy unavailable/);
    expect(c.lines).toEqual([]);
  });
});
