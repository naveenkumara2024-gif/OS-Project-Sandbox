import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import type { Engine } from '../../engine/engine.js';
import { nullLogger, type Logger } from '../../util/logger.js';
import { VERSION } from '../../version.js';
import {
  errorMessage,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  LineFramer,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  parseMessage,
  resultMessage,
  UNSUPPORTED_PROTOCOL_VERSION,
  type JsonRpcId,
} from './jsonrpc.js';
import { buildTools, type ToolDef, type ToolResult } from './tools.js';

// The MCP server (prompt Stage 5 section 4.6): hand-written JSON-RPC over the stdio binding, both
// protocol eras. Legacy revisions open with `initialize`; the modern revision is stateless, every
// request carries its protocol version in `_meta`, and `server/discover` replaces the handshake.
// Nothing but valid MCP messages is ever written to the output stream.

/** Versions that need no handshake (per-request `_meta`). */
export const MODERN_VERSIONS: readonly string[] = ['2026-07-28'];
/** Versions that open with `initialize`. */
export const LEGACY_VERSIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

export const MAX_IN_FLIGHT = 8;

const PV = 'io.modelcontextprotocol/protocolVersion';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

const INSTRUCTIONS =
  'AegisEngine runs code in an isolated, network-less cell and returns a receipt. Use `run` to execute ' +
  'a command (command[0] is an absolute path such as /usr/bin/python3), pass `files` or ' +
  '`workspace.source` to give it files, and reuse the returned `session` to keep working on them. ' +
  'The program never changes the real project: review with `diff`, then `commit` the paths a person ' +
  'approves using the `changes_sha256` from that diff.';

const initializeParams = z.looseObject({ protocolVersion: z.string().max(64) });
const callParams = z.looseObject({
  name: z.string().max(128),
  arguments: z.unknown().optional(),
});
const cancelParams = z.looseObject({ requestId: z.union([z.string(), z.number()]) });

interface InFlight {
  cancelled: boolean;
  readonly cancels: (() => void)[];
}

const keyOf = (id: JsonRpcId): string => `${typeof id}:${String(id)}`;

function metaOf(params: unknown): Record<string, unknown> | null {
  if (typeof params !== 'object' || params === null) return null;
  const m: unknown = Reflect.get(params, '_meta');
  return typeof m === 'object' && m !== null ? (m as Record<string, unknown>) : null;
}

export interface McpOptions {
  readonly engine: Engine;
  readonly write: (line: string) => void;
  readonly logger?: Logger;
}

export class McpServer {
  readonly #engine: Engine;
  readonly #write: (line: string) => void;
  readonly #tools: readonly ToolDef[];
  readonly #inflight = new Map<string, InFlight>();
  readonly #tasks = new Set<Promise<void>>();

  constructor(opts: McpOptions) {
    this.#engine = opts.engine;
    this.#write = opts.write;
    this.#tools = buildTools(opts.engine);
    (opts.logger ?? nullLogger).log({ event: 'mcp_started' });
  }

  #send(line: string): void {
    this.#write(`${line}\n`);
  }

  /** Handles one line of input. Never throws. */
  handleLine(line: string): void {
    const msg = parseMessage(line);
    if (msg.kind === 'invalid') {
      this.#send(errorMessage(msg.id, msg.code, msg.message));
      return;
    }
    if (msg.kind === 'notification') {
      this.#notification(msg.method, msg.params);
      return;
    }
    const task = this.#request(msg.id, msg.method, msg.params).catch(() => {
      this.#send(errorMessage(msg.id, INTERNAL_ERROR, 'internal error'));
    });
    this.#tasks.add(task);
    void task.finally(() => {
      this.#tasks.delete(task);
    });
  }

  handleBad(reason: 'too_long' | 'bad_utf8'): void {
    this.#send(
      errorMessage(
        null,
        reason === 'too_long' ? INVALID_REQUEST : PARSE_ERROR,
        reason === 'too_long' ? 'message too long' : 'parse error',
      ),
    );
  }

  #notification(method: string, params: unknown): void {
    if (method !== 'notifications/cancelled') return; // initialized, progress, ... need no action
    const p = cancelParams.safeParse(params);
    if (!p.success) return;
    const entry = this.#inflight.get(keyOf(p.data.requestId));
    if (entry === undefined) return;
    entry.cancelled = true;
    for (const fn of entry.cancels) fn();
  }

  /** Resolves when every request in flight has been answered or dropped. */
  async idle(): Promise<void> {
    while (this.#tasks.size > 0) await Promise.all([...this.#tasks]);
  }

  /** Called when the input ends: cancel what is running, wait for it, stop the engine. */
  async shutdown(): Promise<void> {
    for (const entry of this.#inflight.values()) {
      entry.cancelled = true;
      for (const fn of entry.cancels) fn();
    }
    await this.idle();
    await this.#engine.close();
  }

  // ---- requests ------------------------------------------------------------------------------

  async #request(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const meta = metaOf(params);
    const modern = meta !== null && typeof meta[PV] === 'string';
    if (modern) {
      const version = meta[PV] as string;
      if (!MODERN_VERSIONS.includes(version)) {
        this.#send(
          errorMessage(id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
            supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
            requested: version,
          }),
        );
        return;
      }
      if (typeof meta[CAPS] !== 'object' || meta[CAPS] === null) {
        this.#send(errorMessage(id, INVALID_PARAMS, `missing required _meta field ${CAPS}`));
        return;
      }
    }
    const done = (result: Record<string, unknown>): void => {
      this.#send(resultMessage(id, modern ? { resultType: 'complete', ...result } : result));
    };

    switch (method) {
      case 'initialize': {
        const p = initializeParams.safeParse(params);
        if (!p.success) {
          this.#send(errorMessage(id, INVALID_PARAMS, 'invalid initialize parameters'));
          return;
        }
        const requested = p.data.protocolVersion;
        const negotiated = LEGACY_VERSIONS.includes(requested)
          ? requested
          : (LEGACY_VERSIONS[0] ?? requested);
        this.#send(
          resultMessage(id, {
            protocolVersion: negotiated,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'aegis', title: 'AegisEngine', version: VERSION },
            instructions: INSTRUCTIONS,
          }),
        );
        return;
      }
      case 'server/discover':
        this.#send(
          resultMessage(id, {
            resultType: 'complete',
            supportedVersions: [...MODERN_VERSIONS],
            capabilities: { tools: {} },
            _meta: { [SERVER_INFO]: { name: 'aegis', version: VERSION } },
            instructions: INSTRUCTIONS,
          }),
        );
        return;
      case 'ping':
        done({});
        return;
      case 'tools/list':
        done({
          tools: this.#tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          })),
        });
        return;
      case 'tools/call':
        await this.#call(id, params, done);
        return;
      default:
        this.#send(errorMessage(id, METHOD_NOT_FOUND, 'method not found'));
    }
  }

  async #call(
    id: JsonRpcId,
    params: unknown,
    done: (result: Record<string, unknown>) => void,
  ): Promise<void> {
    const p = callParams.safeParse(params);
    if (!p.success) {
      this.#send(errorMessage(id, INVALID_PARAMS, 'invalid tools/call parameters'));
      return;
    }
    const tool = this.#tools.find((t) => t.name === p.data.name);
    if (tool === undefined) {
      this.#send(errorMessage(id, INVALID_PARAMS, 'unknown tool'));
      return;
    }
    const asResult = (r: ToolResult): Record<string, unknown> => ({ ...r });
    if (this.#inflight.size >= MAX_IN_FLIGHT) {
      done(
        asResult({
          content: [
            { type: 'text', text: '{"error":{"code":"busy","detail":"too many calls in flight"}}' },
          ],
          isError: true,
        }),
      );
      return;
    }
    const entry: InFlight = { cancelled: false, cancels: [] };
    const key = keyOf(id);
    this.#inflight.set(key, entry);
    let result: ToolResult;
    try {
      result = await tool.call(p.data.arguments, {
        onCancel: (fn) => {
          if (entry.cancelled) fn();
          else entry.cancels.push(fn);
        },
      });
    } catch {
      result = {
        content: [
          { type: 'text', text: '{"error":{"code":"internal","detail":"the tool failed"}}' },
        ],
        isError: true,
      };
    } finally {
      this.#inflight.delete(key);
    }
    // A cancelled request gets no further message (MCP cancellation rules).
    if (entry.cancelled) return;
    done(asResult(result));
  }
}

/** Connects the server to a pair of streams (stdin and stdout in `aegis mcp`). */
export function serveStdio(opts: {
  readonly engine: Engine;
  readonly input: Readable;
  readonly output: Writable;
  readonly logger?: Logger;
}): Promise<void> {
  const server = new McpServer({
    engine: opts.engine,
    write: (line) => {
      opts.output.write(line);
    },
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
  });
  const framer = new LineFramer();
  return new Promise((resolve) => {
    opts.input.on('data', (chunk: Buffer) => {
      for (const ev of framer.push(chunk)) {
        if (ev.kind === 'line') server.handleLine(ev.text);
        else server.handleBad(ev.reason);
      }
    });
    opts.input.once('end', () => {
      void server.shutdown().then(resolve);
    });
    opts.input.once('error', () => {
      void server.shutdown().then(resolve);
    });
  });
}
