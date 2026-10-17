import { readFileSync, readSync, unlinkSync } from 'node:fs';
import { errnoNumber } from '../collect/classify.js';
import { MAX_REQUEST_BYTES, parseRunRequest } from '../gateway/request.js';
import { defaultSocketPath, Gateway } from '../gateway/server.js';
import { errFromException, errnoCode, ok, type Result } from '../util/result.js';
import {
  EX_DATAERR,
  EX_SOFTWARE,
  EX_USAGE,
  fileLogger,
  openEngine,
  reapOrphans,
  refusedForPolicy,
  stderrLogger,
} from './context.js';

// The command-line modes other than `probe` (which main.ts handles). Each prints one JSON document
// on stdout, as before; the engine does the work (src/engine/).

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * Reads the request from a file or stdin. At most MAX_REQUEST_BYTES + 1 bytes are kept, so an
 * oversize request is detected by the schema layer without ever being held in full.
 */
function readRequest(path: string | null): Result<Buffer> {
  const limit = MAX_REQUEST_BYTES + 1;
  try {
    if (path !== null) {
      return ok(readFileSync(path).subarray(0, limit));
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.alloc(64 * 1024);
    while (total < limit) {
      let n: number;
      try {
        n = readSync(0, chunk, 0, Math.min(chunk.length, limit - total), null);
      } catch (e) {
        if (errnoCode(e) === 'EAGAIN') continue;
        if (errnoCode(e) === 'EOF') break;
        throw e;
      }
      if (n === 0) break;
      chunks.push(Buffer.from(chunk.subarray(0, n)));
      total += n;
    }
    return ok(Buffer.concat(chunks, total));
  } catch (e) {
    return errFromException(e, 'read request');
  }
}

export async function runMode(args: readonly string[]): Promise<number> {
  let file: string | null = null;
  if (args.length === 2 && args[0] === '--file' && args[1] !== undefined) {
    file = args[1];
  } else if (args.length !== 0) {
    process.stderr.write('usage: aegis run [--file <request.json>]\n');
    return EX_USAGE;
  }

  const bytes = readRequest(file);
  if (!bytes.ok) {
    printJson({ error: { code: 'unreadable_request', detail: bytes.error.code } });
    return EX_DATAERR;
  }
  const req = parseRunRequest(bytes.value);
  if (!req.ok) {
    printJson({ error: { code: 'invalid_request', detail: req.error.context } });
    return EX_DATAERR;
  }

  const opened = openEngine(process.env);
  if (!opened.ok) {
    if (opened.kind === 'policy') {
      const refused = refusedForPolicy(opened.error.code);
      printJson({
        id: req.value.id,
        ...refused,
        termination: { ...refused.termination, errno: errnoNumber('EINVAL') },
      });
      return EX_DATAERR;
    }
    printJson({
      id: req.value.id,
      error: { code: 'helper_unavailable', detail: opened.error.code },
    });
    return EX_SOFTWARE;
  }

  await reapOrphans();
  const { engine } = opened.value;
  engine.sessions.sweepOrphans();
  // The one-shot CLI keeps using the request id as the session id, so `aegis commit <id>` works.
  const started = engine.startRun({ request: req.value, idMode: 'request' });
  if (!started.ok) {
    printJson({
      id: req.value.id,
      error: { code: 'internal_error', detail: `${started.error.code}: ${started.error.context}` },
    });
    return EX_SOFTWARE;
  }
  const result = await started.value.result;
  await engine.close();
  if (!result.ok) {
    printJson({
      id: req.value.id,
      error: { code: 'internal_error', detail: `${result.error.code}: ${result.error.context}` },
    });
    return EX_SOFTWARE;
  }
  printJson(result.value);
  return 0;
}

export function diffMode(args: readonly string[]): number {
  const id = args[0];
  if (id === undefined) {
    process.stderr.write('usage: aegis diff <session-id>\n');
    return EX_USAGE;
  }
  const opened = openEngine(process.env);
  if (!opened.ok) {
    printJson({
      id,
      error: { code: `${opened.kind ?? 'engine'}_unavailable`, detail: opened.error.code },
    });
    return EX_DATAERR;
  }
  const d = opened.value.engine.diff(id, { adopt: true });
  if (!d.ok) {
    printJson({ id, error: { code: 'no_such_session', detail: d.error.context } });
    return EX_DATAERR;
  }
  printJson(d.value);
  return 0;
}

export async function commitMode(args: readonly string[]): Promise<number> {
  const id = args[0];
  if (id === undefined) {
    process.stderr.write(
      'usage: aegis commit <session-id> [--dest <path>] [--paths p1,p2,...] [--expect <changes_sha256>]\n',
    );
    return EX_USAGE;
  }
  let dest: string | undefined;
  let paths: string[] | null = null;
  let expect: string | null = null;
  for (let i = 1; i < args.length; i += 2) {
    if (args[i] === '--dest') dest = args[i + 1];
    else if (args[i] === '--paths') paths = (args[i + 1] ?? '').split(',').filter((p) => p !== '');
    else if (args[i] === '--expect') expect = args[i + 1] ?? null;
  }
  const opened = openEngine(process.env);
  if (!opened.ok) {
    printJson({
      id,
      error: { code: `${opened.kind ?? 'engine'}_unavailable`, detail: opened.error.code },
    });
    return EX_DATAERR;
  }
  const r = await opened.value.engine.commit(id, {
    paths,
    expectedChangesSha256: expect,
    adopt: true,
    ...(dest === undefined ? {} : { dest }),
  });
  if (!r.ok) {
    printJson({ id, error: { code: 'commit_refused', detail: r.error.code } });
    return EX_DATAERR;
  }
  if (r.value.kind === 'stale') {
    printJson({ id, error: { code: 'stale_diff' }, diff: r.value.diff });
    return EX_DATAERR;
  }
  printJson({ id, outcomes: r.value.outcomes, changes_sha256: r.value.changes_sha256 });
  return 0;
}

export function discardMode(args: readonly string[]): number {
  const id = args[0];
  if (id === undefined) {
    process.stderr.write('usage: aegis discard <session-id>\n');
    return EX_USAGE;
  }
  const opened = openEngine(process.env);
  if (!opened.ok) {
    printJson({
      id,
      error: { code: `${opened.kind ?? 'engine'}_unavailable`, detail: opened.error.code },
    });
    return EX_DATAERR;
  }
  const r = opened.value.engine.discard(id, { adopt: true });
  if (!r.ok) {
    printJson({ id, error: { code: 'discard_failed', detail: r.error.context } });
    return EX_SOFTWARE;
  }
  printJson({ id, discarded: true });
  return 0;
}

/** `aegis serve`: the local gateway, until SIGINT or SIGTERM. */
export async function serveMode(args: readonly string[]): Promise<number> {
  if (args.length !== 0) {
    process.stderr.write('usage: aegis serve\n');
    return EX_USAGE;
  }
  const logger = fileLogger(process.env);
  const opened = openEngine(process.env, logger);
  if (!opened.ok) {
    process.stderr.write(
      `aegis serve: cannot start: ${opened.kind ?? 'engine'} unavailable (${opened.error.code}); ${opened.error.context}\n`,
    );
    return EX_DATAERR;
  }
  const socket = defaultSocketPath(process.env);
  if (!socket.ok) {
    process.stderr.write(`aegis serve: ${socket.error.context}\n`);
    return EX_DATAERR;
  }
  await reapOrphans();
  const { engine } = opened.value;
  engine.start();
  const gw = await Gateway.start({ socketPath: socket.value, engine, logger });
  if (!gw.ok) {
    process.stderr.write(`aegis serve: ${gw.error.code}: ${gw.error.context}\n`);
    await engine.close();
    return EX_SOFTWARE;
  }
  process.stderr.write(`aegis serve: listening on ${socket.value}\n`);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await gw.value.close();
  await engine.close();
  try {
    unlinkSync(socket.value);
  } catch {
    // Closing the server already removed it.
  }
  return 0;
}

export { stderrLogger };
