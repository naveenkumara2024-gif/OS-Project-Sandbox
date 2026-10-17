import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine/engine.js';
import { realPlanEnv } from '../../src/launch/rootfs-plan.js';
import { LEGACY_VERSIONS, MODERN_VERSIONS, McpServer } from '../../src/gateway/mcp/server.js';
import { VERSION } from '../../src/version.js';
import { testPolicy } from '../helpers/engine.js';

// Protocol-level behaviour of the MCP server. No cell is started here (tool calls that run code
// are in tests/integration/mcp-session.test.ts).

function harness() {
  const out: string[] = [];
  const engine = new Engine({
    helperPath: '/nonexistent/aegis-cell',
    planEnv: realPlanEnv(),
    policy: testPolicy(),
  });
  const server = new McpServer({ engine, write: (l) => out.push(l) });
  const send = async (msg: unknown): Promise<void> => {
    server.handleLine(typeof msg === 'string' ? msg : JSON.stringify(msg));
    await server.idle();
  };
  const last = (): Record<string, unknown> =>
    JSON.parse(out[out.length - 1] ?? 'null') as Record<string, unknown>;
  return { out, send, last, engine };
}

const modernMeta = (version = '2026-07-28') => ({
  _meta: {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientCapabilities': {},
  },
});

describe('MCP server', () => {
  it('answers the legacy handshake with the requested version, tools capability and server info', async () => {
    const h = harness();
    await h.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    });
    expect(h.last()).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'aegis', version: VERSION },
      },
    });
    expect('resultType' in (h.last()['result'] as object)).toBe(false); // legacy results carry none
    const before = h.out.length;
    await h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(h.out.length).toBe(before); // a notification never gets a reply
  });

  it('offers its latest legacy version when the client asks for one it does not know', async () => {
    const h = harness();
    for (const v of ['1999-01-01', '2026-07-28', 'nonsense']) {
      await h.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: v } });
      expect(h.last()).toMatchObject({ result: { protocolVersion: LEGACY_VERSIONS[0] } });
    }
    await h.send({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
    expect(h.last()).toMatchObject({ error: { code: -32602 } });
  });

  it('answers server/discover for the modern era, and tools/list with resultType', async () => {
    const h = harness();
    await h.send({ jsonrpc: '2.0', id: 'd1', method: 'server/discover', params: modernMeta() });
    expect(h.last()).toMatchObject({
      id: 'd1',
      result: {
        resultType: 'complete',
        supportedVersions: [...MODERN_VERSIONS],
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'aegis', version: VERSION } },
      },
    });
    await h.send({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: modernMeta() });
    expect(h.last()).toMatchObject({ result: { resultType: 'complete' } });
  });

  it('refuses an unsupported modern version with -32022 and the supported list', async () => {
    const h = harness();
    await h.send({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: modernMeta('2099-01-01') });
    expect(h.last()).toMatchObject({
      id: 9,
      error: { code: -32022, data: { requested: '2099-01-01' } },
    });
    const data = (h.last()['error'] as { data: { supported: string[] } }).data;
    expect(data.supported).toEqual(expect.arrayContaining(['2026-07-28', '2025-11-25']));
  });

  it('refuses a modern request with no client capabilities (-32602)', async () => {
    const h = harness();
    await h.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    });
    expect(h.last()).toMatchObject({ error: { code: -32602 } });
  });

  it('lists the five tools in a stable order, each with an object input schema and annotations', async () => {
    const h = harness();
    await h.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const first = JSON.stringify(h.last());
    await h.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(JSON.stringify(h.last())).toBe(first);
    const tools = (h.last()['result'] as { tools: Record<string, unknown>[] }).tools;
    expect(tools.map((t) => t['name'])).toEqual(['run', 'status', 'diff', 'commit', 'discard']);
    for (const t of tools) {
      expect(t['name']).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
      expect(typeof t['description']).toBe('string');
      expect(t['inputSchema']).toMatchObject({ type: 'object' });
      expect('$schema' in (t['inputSchema'] as object)).toBe(false);
      expect(t['annotations']).toMatchObject({ openWorldHint: false });
    }
    const run = tools[0] as {
      inputSchema: { properties: Record<string, unknown>; additionalProperties: unknown };
    };
    expect(Object.keys(run.inputSchema.properties)).toEqual(
      expect.arrayContaining(['command', 'files', 'workspace', 'session', 'manifest', 'limits']),
    );
    expect(run.inputSchema.additionalProperties).toBe(false);
    const commit = tools[3] as { inputSchema: { required: string[] } };
    expect(commit.inputSchema.required).toEqual(
      expect.arrayContaining(['session', 'paths', 'expected_changes_sha256']),
    );
    expect(tools[3]).toMatchObject({ annotations: { destructiveHint: true } });
    expect(tools[1]).toMatchObject({ annotations: { readOnlyHint: true } });
  });

  it('answers ping, and unknown methods with -32601', async () => {
    const h = harness();
    await h.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(h.last()).toMatchObject({ id: 1, result: {} });
    await h.send({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
    expect(h.last()).toMatchObject({ id: 2, error: { code: -32601 } });
  });

  it('protocol errors for a malformed tools/call, an unknown tool, and bad JSON-RPC', async () => {
    const h = harness();
    await h.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { arguments: {} } });
    expect(h.last()).toMatchObject({ error: { code: -32602 } });
    await h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'rm_rf' } });
    expect(h.last()).toMatchObject({ error: { code: -32602 } });
    await h.send('{ not json');
    expect(h.last()).toMatchObject({ id: null, error: { code: -32700 } });
    await h.send('[{"jsonrpc":"2.0","id":1,"method":"ping"}]');
    expect(h.last()).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it('argument problems are tool results with isError, not protocol errors, and never echo values', async () => {
    const h = harness();
    const call = async (name: string, args: unknown) => {
      await h.send({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name, arguments: args },
      });
      return h.last()['result'] as { isError: boolean; content: { text: string }[] };
    };
    for (const [name, args] of [
      ['run', { command: ['relative'] }],
      ['run', { command: ['/usr/bin/true'], extra: 'SECRETXYZ' }],
      ['run', 'not an object'],
      ['diff', { session: 'my-run' }],
      ['diff', {}],
      ['commit', { session: 's-' + 'a'.repeat(32), paths: [], expected_changes_sha256: 'x' }],
      [
        'commit',
        {
          session: 's-' + 'a'.repeat(32),
          paths: ['../etc/passwd'],
          expected_changes_sha256: 'a'.repeat(64),
        },
      ],
      ['discard', { session: 's-' + 'a'.repeat(32), force: true }],
      ['status', { surprise: 1 }],
    ] as const) {
      const r = await call(name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(r.content[0]?.text).not.toContain('SECRETXYZ');
      expect(JSON.parse(r.content[0]?.text ?? '{}')).toMatchObject({
        error: { code: 'invalid_request' },
      });
    }
  });

  it('an unknown session is a tool error with a closed code', async () => {
    const h = harness();
    await h.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'diff', arguments: { session: 's-' + '0'.repeat(32) } },
    });
    const r = h.last()['result'] as { isError: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]?.text ?? '{}')).toMatchObject({ error: { code: 'not_found' } });
  });

  it('status returns the engine state and the ceiling, as text and structured content', async () => {
    const h = harness();
    await h.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status' } });
    const r = h.last()['result'] as {
      isError?: boolean;
      content: { type: string; text: string }[];
      structuredContent: {
        ceiling: { limits: { memory_mb: number } };
        cells: object;
        sessions: unknown[];
      };
    };
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.ceiling.limits.memory_mb).toBe(2048);
    expect(r.structuredContent.sessions).toEqual([]);
    expect(JSON.parse(r.content[0]?.text ?? '{}')).toEqual(r.structuredContent);
  });

  it('keeps the version constant equal to package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
    ) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});
