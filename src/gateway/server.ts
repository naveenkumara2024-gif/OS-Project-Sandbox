import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Engine } from '../engine/engine.js';
import type { RunEvent } from '../engine/events.js';
import { nullLogger, type Logger } from '../util/logger.js';
import { ensurePrivateDir } from '../util/state-dir.js';
import { err, errFromException, ok, type Result } from '../util/result.js';
import { DEFAULT_LIMITS, type GatewayLimits } from './limits.js';
import { parseRunRequest } from './request.js';
import {
  codeFor,
  commitBodySchema,
  MESSAGES,
  SESSION_ID,
  STATUS,
  type ErrorCode,
} from './errors.js';

export { codeFor };

// The local gateway (prompt Stage 5 section 4.4): HTTP/1.1 over a Unix socket in a private
// directory, mode 0600, no TCP listener. The request is untrusted (CLAUDE.md 6.4): sizes are
// capped while reading and before parsing, the schema is strict, ids are validated before any
// lookup, and every error is one of a closed set of codes with a fixed message that never echoes
// request content.

const ID = /^(?:s|r)-[0-9a-f]{32}$/;
const SESSION = SESSION_ID;

export interface GatewayOptions {
  readonly socketPath: string;
  readonly engine: Engine;
  readonly logger?: Logger;
  readonly limits?: Partial<GatewayLimits>;
}

/** `$XDG_RUNTIME_DIR/aegis/gateway.sock`. There is deliberately no fallback to a shared directory. */
export function defaultSocketPath(env: NodeJS.ProcessEnv): Result<string> {
  const base = env['XDG_RUNTIME_DIR'];
  if (base === undefined || !base.startsWith('/')) {
    return err(
      'EINVAL',
      'XDG_RUNTIME_DIR is not set; the gateway needs a private runtime directory',
    );
  }
  return ok(join(base, 'aegis', 'gateway.sock'));
}

function probeSocket(path: string): Promise<'live' | 'dead'> {
  return new Promise((resolve) => {
    const s: Socket = connect(path);
    const done = (v: 'live' | 'dead'): void => {
      s.destroy();
      resolve(v);
    };
    s.once('connect', () => {
      done('live');
    });
    s.once('error', () => {
      done('dead');
    });
    setTimeout(() => {
      done('dead');
    }, 1000).unref();
  });
}

export class Gateway {
  readonly socketPath: string;
  readonly #server: Server;
  readonly #engine: Engine;
  readonly #log: Logger;
  readonly #limits: GatewayLimits;

  private constructor(opts: GatewayOptions, limits: GatewayLimits) {
    this.socketPath = opts.socketPath;
    this.#engine = opts.engine;
    this.#log = opts.logger ?? nullLogger;
    this.#limits = limits;
    this.#server = createServer(
      {
        maxHeaderSize: limits.maxHeaderBytes,
        headersTimeout: limits.headersTimeoutMs,
        requestTimeout: limits.requestTimeoutMs,
        keepAliveTimeout: limits.keepAliveTimeoutMs,
        connectionsCheckingInterval: Math.min(1000, limits.headersTimeoutMs),
      },
      (req, res) => {
        void this.#handle(req, res).catch(() => {
          this.#fail(res, 'internal');
        });
      },
    );
    this.#server.maxConnections = limits.maxConnections;
    this.#server.on('clientError', (_e, socket) => {
      this.#log.log({ event: 'gateway_rejected', reason: 'client_error', status: 400 });
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
  }

  static async start(opts: GatewayOptions): Promise<Result<Gateway>> {
    const limits = { ...DEFAULT_LIMITS, ...opts.limits };
    const dir = ensurePrivateDir(dirname(opts.socketPath));
    if (!dir.ok) return dir;
    // A leftover socket is removed only if nobody is listening on it.
    try {
      const st = lstatSync(opts.socketPath);
      if (!st.isSocket()) return err('EEXIST', 'the socket path exists and is not a socket');
      if ((await probeSocket(opts.socketPath)) === 'live') {
        return err('EADDRINUSE', 'another engine is already listening on this socket');
      }
      unlinkSync(opts.socketPath);
    } catch (e) {
      if (!(typeof e === 'object' && e !== null && Reflect.get(e, 'code') === 'ENOENT')) {
        return errFromException(e, 'check the socket path');
      }
    }
    const gw = new Gateway(opts, limits);
    // umask is process-wide; it is tightened only around bind and restored at once. The private
    // parent directory is the primary protection, and the chmod below makes the mode explicit.
    const old = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        gw.#server.once('error', reject);
        gw.#server.listen(opts.socketPath, () => {
          gw.#server.off('error', reject);
          resolve();
        });
      });
    } catch (e) {
      return errFromException(e, 'listen on the gateway socket');
    } finally {
      process.umask(old);
    }
    try {
      chmodSync(opts.socketPath, 0o600);
    } catch (e) {
      await gw.close();
      return errFromException(e, 'set the socket mode');
    }
    gw.#log.log({ event: 'gateway_listening' });
    return ok(gw);
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
    try {
      unlinkSync(this.socketPath);
    } catch {
      // Already gone (closing the server removes a Unix socket it created).
    }
  }

  // ---- plumbing ------------------------------------------------------------------------------

  #json(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    });
    res.end(text);
  }

  #fail(res: ServerResponse, code: ErrorCode, extra: Record<string, unknown> = {}): void {
    const status = STATUS[code];
    this.#log.log({ event: 'gateway_rejected', reason: code, status });
    this.#json(res, status, { error: { code, detail: MESSAGES[code] }, ...extra });
  }

  /** Reads the body with the cap enforced while reading; null means the response was sent. */
  async #body(
    req: IncomingMessage,
    res: ServerResponse,
    required: boolean,
  ): Promise<Buffer | null> {
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      const n = Number(declared);
      if (!Number.isInteger(n) || n < 0) {
        this.#fail(res, 'invalid_request');
        return null;
      }
      if (n > this.#limits.maxBodyBytes) {
        res.setHeader('connection', 'close');
        this.#fail(res, 'too_large');
        return null;
      }
    } else if (req.headers['transfer-encoding'] === undefined && required) {
      this.#fail(res, 'invalid_request');
      return null;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > this.#limits.maxBodyBytes) {
        res.setHeader('connection', 'close');
        this.#fail(res, 'too_large');
        req.destroy();
        return null;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }

  #jsonBody(req: IncomingMessage): boolean {
    return (req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json');
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? '';
    // Node's own maxHeadersCount truncates silently, so the count is enforced here instead.
    if (req.rawHeaders.length / 2 > this.#limits.maxHeaders) {
      res.setHeader('connection', 'close');
      this.#fail(res, 'invalid_request');
      return;
    }
    // Only the path matters; a query string is ignored, and nothing is taken from it.
    const path = (req.url ?? '').split('?')[0] ?? '';
    const parts = path.split('/').filter((p) => p !== '');
    if (parts[0] !== 'v1' || path.includes('..') || path.includes('//') || path.includes('%')) {
      this.#fail(res, 'not_found');
      return;
    }

    // GET /v1/status
    if (parts.length === 2 && parts[1] === 'status') {
      if (method !== 'GET') {
        this.#fail(res, 'unsupported');
        return;
      }
      this.#json(res, 200, this.#engine.status());
      return;
    }

    // POST /v1/runs
    if (parts.length === 2 && parts[1] === 'runs') {
      if (method !== 'POST') {
        this.#fail(res, 'unsupported');
        return;
      }
      if (!this.#jsonBody(req)) {
        this.#fail(res, 'unsupported');
        return;
      }
      const body = await this.#body(req, res, true);
      if (body === null) return;
      const parsed = parseRunRequest(body);
      if (!parsed.ok) {
        this.#fail(res, parsed.error.code === 'E2BIG' ? 'too_large' : 'invalid_request');
        return;
      }
      const started = this.#engine.startRun({ request: parsed.value, idMode: 'server' });
      if (!started.ok) {
        this.#fail(res, codeFor(started.error.code));
        return;
      }
      this.#json(res, 202, { run: started.value.id, session: started.value.session });
      return;
    }

    // /v1/runs/{id}[/events|/cancel]
    if (parts[1] === 'runs' && parts.length >= 3 && parts.length <= 4) {
      const id = parts[2] ?? '';
      if (!ID.test(id)) {
        this.#fail(res, 'not_found');
        return;
      }
      const run = this.#engine.getRun(id);
      if (run === undefined) {
        this.#fail(res, 'not_found');
        return;
      }
      const sub = parts[3];
      if (sub === undefined) {
        if (method !== 'GET') {
          this.#fail(res, 'unsupported');
          return;
        }
        this.#json(res, 200, {
          run: run.id,
          session: run.session,
          state: run.state,
          ...(run.result?.ok === true ? { receipt: run.result.value } : {}),
          ...(run.result?.ok === false
            ? {
                error: {
                  code: codeFor(run.result.error.code),
                  detail: MESSAGES[codeFor(run.result.error.code)],
                },
              }
            : {}),
        });
        return;
      }
      if (sub === 'events') {
        if (method !== 'GET') {
          this.#fail(res, 'unsupported');
          return;
        }
        await this.#stream(req, res, run.events.subscribe());
        return;
      }
      if (sub === 'cancel') {
        if (method !== 'POST') {
          this.#fail(res, 'unsupported');
          return;
        }
        const body = await this.#body(req, res, false);
        if (body === null) return;
        if (body.length > 0) {
          this.#fail(res, 'invalid_request');
          return;
        }
        const c = this.#engine.cancelRun(id);
        if (!c.ok) {
          this.#fail(res, codeFor(c.error.code));
          return;
        }
        this.#json(res, 202, { run: id, cancelling: true });
        return;
      }
      this.#fail(res, 'not_found');
      return;
    }

    // /v1/sessions/{id}[/diff|/commit]
    if (parts[1] === 'sessions' && parts.length >= 3 && parts.length <= 4) {
      const id = parts[2] ?? '';
      if (!SESSION.test(id)) {
        this.#fail(res, 'not_found');
        return;
      }
      const sub = parts[3];
      if (sub === undefined) {
        if (method !== 'DELETE') {
          this.#fail(res, 'unsupported');
          return;
        }
        const d = this.#engine.discard(id);
        if (!d.ok) {
          this.#fail(res, codeFor(d.error.code));
          return;
        }
        this.#json(res, 200, { session: id, discarded: true });
        return;
      }
      if (sub === 'diff') {
        if (method !== 'GET') {
          this.#fail(res, 'unsupported');
          return;
        }
        const d = this.#engine.diff(id);
        if (!d.ok) {
          this.#fail(res, codeFor(d.error.code));
          return;
        }
        this.#json(res, 200, d.value);
        return;
      }
      if (sub === 'commit') {
        if (method !== 'POST') {
          this.#fail(res, 'unsupported');
          return;
        }
        if (!this.#jsonBody(req)) {
          this.#fail(res, 'unsupported');
          return;
        }
        const body = await this.#body(req, res, true);
        if (body === null) return;
        const args = parseCommitBody(body);
        if (!args.ok) {
          this.#fail(res, 'invalid_request');
          return;
        }
        const r = await this.#engine.commit(id, {
          paths: args.value.paths,
          expectedChangesSha256: args.value.expected_changes_sha256,
          ...(args.value.dest === undefined ? {} : { dest: args.value.dest }),
          ...(args.value.close === undefined ? {} : { close: args.value.close }),
        });
        if (!r.ok) {
          this.#fail(res, codeFor(r.error.code));
          return;
        }
        if (r.value.kind === 'stale') {
          this.#fail(res, 'stale_diff', { diff: r.value.diff });
          return;
        }
        this.#json(res, 200, r.value);
        return;
      }
    }

    this.#fail(res, 'not_found');
  }

  async #stream(
    req: IncomingMessage,
    res: ServerResponse,
    events: AsyncIterable<RunEvent>,
  ): Promise<void> {
    res.writeHead(200, {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    const it = events[Symbol.asyncIterator]();
    const state = { gone: false };
    const onClose = (): void => {
      state.gone = true;
      void it.return?.();
    };
    req.on('close', onClose);
    res.on('close', onClose);
    try {
      for (;;) {
        const next = await it.next();
        if (next.done === true || state.gone) break;
        // One event per line. JSON.stringify never emits a raw newline.
        if (!res.write(`${JSON.stringify(next.value)}\n`)) {
          await new Promise<void>((resolve) => {
            res.once('drain', resolve);
            res.once('close', resolve);
          });
        }
      }
    } finally {
      req.off('close', onClose);
      res.off('close', onClose);
      if (!state.gone) res.end();
    }
  }
}

function parseCommitBody(body: Buffer): Result<z.infer<typeof commitBodySchema>> {
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString('utf8'), (key: string, value: unknown) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new Error('forbidden key');
      }
      return value;
    });
  } catch {
    return err('EINVAL', 'invalid JSON');
  }
  const parsed = commitBodySchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err('EINVAL', 'invalid commit request');
}
