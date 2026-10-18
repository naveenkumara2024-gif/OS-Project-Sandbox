import { chmodSync, unlinkSync } from 'node:fs';
import { promises as dns } from 'node:dns';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { nullLogger, type Logger } from '../util/logger.js';
import { errFromException, ok, type Result } from '../util/result.js';
import { AuditLog, type AuditReason } from './audit.js';
import { allPublic, type Cidr4 } from './address-policy.js';
import { MAX_HEAD_BYTES, parseConnect } from './connect-parser.js';

// The egress broker (prompt Stage 5 section 4.7): one per brokered cell, listening on a Unix socket
// inside the per-cell directory. The cell has no network interface; the only way out is an HTTP
// CONNECT over this socket to a hostname on the manifest's allowlist, to a port the ceiling allows,
// at a public address that the broker resolved itself and then connects to by number.

export type Resolver = (host: string) => Promise<string[]>;
export type Dialer = (ip: string, port: number) => Promise<Socket>;

export interface BrokerLimits {
  readonly maxTunnels: number;
  readonly idleMs: number;
  readonly lifetimeMs: number;
  readonly maxBytes: number;
  readonly headMs: number;
  readonly connectMs: number;
  readonly resolveMs: number;
}

export const DEFAULT_BROKER_LIMITS: BrokerLimits = {
  maxTunnels: 16,
  idleMs: 60_000,
  lifetimeMs: 10 * 60_000,
  maxBytes: 64 * 1024 * 1024,
  headMs: 5_000,
  connectMs: 10_000,
  resolveMs: 5_000,
};

export const systemResolver: Resolver = async (host) => {
  const all = await dns.lookup(host, { all: true });
  return all.map((a) => a.address);
};

export const systemDialer = (connectMs: number): Dialer => {
  return (ip, port) =>
    new Promise((resolve, reject) => {
      const s = connect({ host: ip, port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error('connect timeout'));
      }, connectMs);
      s.once('connect', () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
};

export interface BrokerOptions {
  readonly socketPath: string;
  readonly run: string;
  readonly manifestSha256: string;
  /** Lower-case hostnames the manifest listed and the ceiling allowed. */
  readonly allow: readonly string[];
  readonly ports: readonly number[];
  readonly hostRanges: readonly Cidr4[];
  readonly audit: AuditLog;
  readonly resolver?: Resolver;
  readonly dial?: Dialer;
  readonly logger?: Logger;
  readonly limits?: Partial<BrokerLimits>;
}

const STATUS_LINES: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  405: 'Method Not Allowed',
  429: 'Too Many Requests',
  502: 'Bad Gateway',
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error('failed'));
      },
    );
  });
}

interface Tunnel {
  readonly client: Socket;
  readonly upstream: Socket;
  finish(reason: AuditReason): void;
}

export class Broker implements AsyncDisposable {
  readonly socketPath: string;
  readonly #opts: BrokerOptions;
  readonly #limits: BrokerLimits;
  readonly #allow: ReadonlySet<string>;
  readonly #server: Server;
  readonly #log: Logger;
  readonly #resolve: Resolver;
  readonly #dial: Dialer;
  readonly #tunnels = new Set<Tunnel>();
  readonly #clients = new Set<Socket>();
  #closed = false;

  private constructor(opts: BrokerOptions) {
    this.#opts = opts;
    this.socketPath = opts.socketPath;
    this.#limits = { ...DEFAULT_BROKER_LIMITS, ...opts.limits };
    this.#allow = new Set(opts.allow);
    this.#log = opts.logger ?? nullLogger;
    this.#resolve = opts.resolver ?? systemResolver;
    this.#dial = opts.dial ?? systemDialer(this.#limits.connectMs);
    this.#server = createServer((c) => {
      this.#clients.add(c);
      c.once('close', () => {
        this.#clients.delete(c);
      });
      void this.#serve(c).catch(() => {
        c.destroy();
      });
    });
  }

  static async create(opts: BrokerOptions): Promise<Result<Broker>> {
    const b = new Broker(opts);
    try {
      await new Promise<void>((resolve, reject) => {
        b.#server.once('error', reject);
        b.#server.listen(opts.socketPath, () => {
          b.#server.off('error', reject);
          resolve();
        });
      });
      // The per-cell directory is already private; the explicit mode keeps the socket 0600 too.
      chmodSync(opts.socketPath, 0o600);
    } catch (e) {
      return errFromException(e, 'listen on the broker socket');
    }
    return ok(b);
  }

  #record(
    host: string,
    port: number,
    decision: 'allow' | 'deny',
    reason: AuditReason,
    started: number,
    extra: { resolved?: string; up?: number; down?: number } = {},
  ): void {
    this.#opts.audit.add({
      ts: Date.now(),
      host,
      port,
      decision,
      reason,
      ...(extra.resolved === undefined ? {} : { resolved: extra.resolved }),
      bytes_up: extra.up ?? 0,
      bytes_down: extra.down ?? 0,
      duration_ms: Math.round(performance.now() - started),
    });
    this.#log.log({
      event: 'broker_decision',
      run: this.#opts.run,
      manifest_sha256: this.#opts.manifestSha256,
      host,
      port,
      decision,
      reason,
    });
  }

  #reject(c: Socket, status: 400 | 403 | 405 | 429 | 502): void {
    const extra = status === 405 ? 'Allow: CONNECT\r\n' : '';
    c.end(
      `HTTP/1.1 ${String(status)} ${STATUS_LINES[status] ?? ''}\r\n${extra}Connection: close\r\n\r\n`,
    );
  }

  async #serve(c: Socket): Promise<void> {
    const started = performance.now();
    // 1. The request head: bounded in size and in time.
    const head = await new Promise<Buffer | null>((resolve) => {
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, this.#limits.headMs);
      const onData = (d: Buffer): void => {
        buf = Buffer.concat([buf, d]);
        if (buf.indexOf('\r\n\r\n') >= 0) {
          cleanup();
          resolve(buf);
        } else if (buf.length > MAX_HEAD_BYTES) {
          cleanup();
          resolve(null);
        }
      };
      const onEnd = (): void => {
        cleanup();
        resolve(null);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        c.off('data', onData);
        c.off('end', onEnd);
        c.off('error', onEnd);
      };
      c.on('data', onData);
      c.once('end', onEnd);
      c.once('error', onEnd);
    });
    if (head === null) {
      this.#record('', 0, 'deny', 'bad_request', started);
      this.#reject(c, 400);
      return;
    }
    const req = parseConnect(head);
    if (!req.ok) {
      this.#record('', 0, 'deny', req.reason, started);
      this.#reject(c, req.reason === 'bad_method' ? 405 : 400);
      return;
    }
    const { host, port } = req;

    // 2. Policy, in order: the name, the port, capacity.
    if (!this.#allow.has(host)) {
      this.#record(host, port, 'deny', 'not_allowlisted', started);
      this.#reject(c, 403);
      return;
    }
    if (!this.#opts.ports.includes(port)) {
      this.#record(host, port, 'deny', 'port_not_allowed', started);
      this.#reject(c, 403);
      return;
    }
    if (this.#tunnels.size >= this.#limits.maxTunnels || this.#closed) {
      this.#record(host, port, 'deny', 'limit', started);
      this.#reject(c, 429);
      return;
    }

    // 3. Resolve here, on the host. Every address must be public; one internal address among
    // public ones is a rebinding attempt and the whole name is refused.
    let ips: string[];
    try {
      ips = await withTimeout(this.#resolve(host), this.#limits.resolveMs);
    } catch {
      this.#record(host, port, 'deny', 'resolve_failed', started);
      this.#reject(c, 502);
      return;
    }
    const verdict = allPublic(ips, this.#opts.hostRanges);
    if (!verdict.public) {
      this.#record(host, port, 'deny', 'private_address', started);
      this.#reject(c, 403);
      return;
    }

    // 4. Connect to the address that was checked, by number: the name is never resolved again.
    const ip = ips[0] ?? '';
    let upstream: Socket;
    try {
      upstream = await this.#dial(ip, port);
    } catch {
      this.#record(host, port, 'deny', 'connect_failed', started);
      this.#reject(c, 502);
      return;
    }
    if (c.destroyed) {
      upstream.destroy();
      return;
    }

    // 5. The tunnel: bounded in count, idle time, lifetime and bytes.
    c.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    let up = 0;
    let down = 0;
    let reason: AuditReason = 'ok';
    let done = false;
    const finish = (why: AuditReason): void => {
      if (done) return;
      done = true;
      reason = why;
      clearTimeout(life);
      c.destroy();
      upstream.destroy();
      this.#tunnels.delete(tunnel);
      this.#record(host, port, 'allow', reason, started, { resolved: ip, up, down });
    };
    const tunnel: Tunnel = { client: c, upstream, finish };
    this.#tunnels.add(tunnel);
    const life = setTimeout(() => {
      finish('limit');
    }, this.#limits.lifetimeMs);
    c.setTimeout(this.#limits.idleMs, () => {
      finish('limit');
    });
    upstream.setTimeout(this.#limits.idleMs, () => {
      finish('limit');
    });
    c.on('data', (d: Buffer) => {
      up += d.length;
      if (up > this.#limits.maxBytes) finish('limit');
    });
    upstream.on('data', (d: Buffer) => {
      down += d.length;
      if (down > this.#limits.maxBytes) finish('limit');
    });
    c.on('close', () => {
      finish('ok');
    });
    upstream.on('close', () => {
      finish('ok');
    });
    c.on('error', () => {
      finish('ok');
    });
    upstream.on('error', () => {
      finish('ok');
    });
    // Bytes the client sent right behind the head (the start of the TLS handshake).
    const leftover = head.subarray(req.consumed);
    if (leftover.length > 0) {
      up += leftover.length;
      upstream.write(leftover);
    }
    c.pipe(upstream);
    upstream.pipe(c);
  }

  /** Stops accepting, ends every tunnel (recording it), and removes the socket. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const t of [...this.#tunnels]) t.finish('ok');
    for (const c of this.#clients) c.destroy();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
    try {
      unlinkSync(this.socketPath);
    } catch {
      // Closing the server already removed it.
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
