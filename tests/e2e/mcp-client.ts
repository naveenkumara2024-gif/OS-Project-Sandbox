import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A scripted MCP client: what a harness does, with the transcript kept. It launches
// `aegis mcp` (dist/main.js) as a child and speaks the stdio binding: one JSON-RPC message per line.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface Reply {
  readonly jsonrpc: string;
  readonly id: number | string | null;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export class McpClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: string[] = [];
  stderr = '';
  #buffer = '';
  #next = 1;
  readonly #waiting = new Map<string, (r: Reply) => void>();
  readonly exited: Promise<number | null>;

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [join(root, 'dist', 'main.js'), 'mcp'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (d: Buffer) => {
      this.#buffer += d.toString('utf8');
      for (;;) {
        const nl = this.#buffer.indexOf('\n');
        if (nl < 0) break;
        const line = this.#buffer.slice(0, nl);
        this.#buffer = this.#buffer.slice(nl + 1);
        this.lines.push(line);
        let msg: Reply | null = null;
        try {
          msg = JSON.parse(line) as Reply;
        } catch {
          msg = null;
        }
        if (msg !== null && msg.id !== null) {
          const w = this.#waiting.get(String(msg.id));
          if (w !== undefined) {
            this.#waiting.delete(String(msg.id));
            w(msg);
          }
        }
      }
    });
    this.child.stderr.on('data', (d: Buffer) => (this.stderr += d.toString('utf8')));
    this.exited = new Promise((resolveExit) => {
      this.child.on('exit', (code) => {
        resolveExit(code);
      });
    });
  }

  /** Sends a request and resolves with its reply (or rejects after `timeoutMs`). */
  request(
    method: string,
    params?: unknown,
    timeoutMs = 30_000,
  ): { id: number; reply: Promise<Reply> } {
    const id = this.#next++;
    const reply = new Promise<Reply>((resolveReply, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(String(id));
        reject(new Error(`no reply to ${method} (id ${String(id)}) in ${String(timeoutMs)} ms`));
      }, timeoutMs);
      this.#waiting.set(String(id), (r) => {
        clearTimeout(timer);
        resolveReply(r);
      });
    });
    this.raw({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    return { id, reply };
  }

  call(method: string, params?: unknown, timeoutMs?: number): Promise<Reply> {
    return this.request(method, params, timeoutMs).reply;
  }

  notify(method: string, params?: unknown): void {
    this.raw({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  raw(msg: unknown): void {
    this.child.stdin.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`);
  }

  /** Calls a tool and returns its result object (throws on a protocol error). */
  async tool(
    name: string,
    args: unknown,
    meta?: unknown,
  ): Promise<{
    isError?: boolean;
    structuredContent: Record<string, unknown>;
    content: { type: string; text: string }[];
  }> {
    const r = await this.call('tools/call', {
      name,
      arguments: args,
      ...(meta === undefined ? {} : { _meta: meta }),
    });
    if (r.error !== undefined) throw new Error(`tools/call ${name}: ${JSON.stringify(r.error)}`);
    return r.result as never;
  }

  /** Closes stdin, as a harness does at shutdown, and waits for the process to exit. */
  async close(timeoutMs = 15_000): Promise<number | null> {
    this.child.stdin.end();
    const timer = setTimeout(() => {
      this.child.kill('SIGKILL');
    }, timeoutMs);
    const code = await this.exited;
    clearTimeout(timer);
    return code;
  }
}
