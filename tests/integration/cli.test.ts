import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../escape/harness.js';
import { helperBuilds } from '../helpers/cell.js';

// The real binaries (dist/main.js) as separate processes: one-shot run/diff/commit/discard through
// the engine, and `aegis serve` with its socket, log file and shutdown.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let work = '';
let fixture: Fixture;
let policyFile = '';
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  // The CLI runs from dist; build it so this test exercises the current source.
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (built.status !== 0) throw new Error(`tsc failed: ${built.stdout}${built.stderr}`);

  fixture = createFixture();
  work = mkdtempSync(join(tmpdir(), 'aegis-cli-'));
  for (const d of ['run', 'state', 'tmp', 'config']) mkdirSync(join(work, d), { mode: 0o700 });
  chmodSync(join(work, 'run'), 0o700);
  const base: unknown = JSON.parse(readFileSync(join(root, 'policy.default.json'), 'utf8'));
  policyFile = join(work, 'policy.json');
  writeFileSync(
    policyFile,
    JSON.stringify({ ...(base as object), ingest_roots: [fixture.project], ingest_excludes: [] }),
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

function aegis(args: string[], input?: string, over: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [join(root, 'dist', 'main.js'), ...args], {
    encoding: 'utf8',
    env: { ...env, ...over },
    ...(input === undefined ? {} : { input }),
  });
  let json: unknown = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

describe('one-shot CLI through the engine', () => {
  it('run, diff, commit (stale then right hash), discard', () => {
    const id = 'cli-session-1';
    const run = aegis(
      ['run'],
      JSON.stringify({
        id,
        command: ['/usr/bin/sh', '-c', 'echo built > out.txt'],
        workspace: { source: fixture.project },
      }),
    );
    expect(run.status).toBe(0);
    expect(run.json).toMatchObject({ session: id, run: id, termination: { cause: 'exit' } });

    const diff = aegis(['diff', id]);
    expect(diff.status).toBe(0);
    const d = diff.json as { changes: { path: string }[]; changes_sha256: string };
    expect(d.changes.map((c) => c.path)).toEqual(['out.txt']);

    const stale = aegis(['commit', id, '--paths', 'out.txt', '--expect', '0'.repeat(64)]);
    expect(stale.status).toBe(65);
    expect(stale.json).toMatchObject({ error: { code: 'stale_diff' } });
    expect(existsSync(join(fixture.project, 'out.txt'))).toBe(false);

    const commit = aegis(['commit', id, '--paths', 'out.txt', '--expect', d.changes_sha256]);
    expect(commit.status).toBe(0);
    expect(readFileSync(join(fixture.project, 'out.txt'), 'utf8')).toBe('built\n');

    expect(aegis(['discard', id]).status).toBe(0);
    expect(aegis(['diff', id]).status).toBe(65);
  });

  it('refuses a run when the policy file is missing, with no fallback to the repository copy', () => {
    const r = aegis(['run'], JSON.stringify({ command: ['/usr/bin/true'] }), {
      AEGIS_POLICY_FILE: join(work, 'nope.json'),
    });
    expect(r.status).toBe(65);
    expect(r.json).toMatchObject({
      termination: { cause: 'isolation_unavailable', layer: 'policy' },
    });
  });

  it('finds the policy at ~/.config/aegis/policy.json when AEGIS_POLICY_FILE is not set', () => {
    mkdirSync(join(work, '.config', 'aegis'), { recursive: true });
    writeFileSync(join(work, '.config', 'aegis', 'policy.json'), readFileSync(policyFile));
    const r = aegis(['run'], JSON.stringify({ command: ['/usr/bin/true'] }), {
      AEGIS_POLICY_FILE: '',
    });
    expect(r.status).toBe(0);
    expect(r.json).toMatchObject({ termination: { cause: 'exit' } });
  });
});

function getStatus(sock: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const req = httpRequest({ socketPath: sock, path: '/v1/status' }, (res) => {
      res.resume();
      res.on('end', () => {
        resolveStatus(res.statusCode ?? 0);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('aegis serve', () => {
  it('listens on a 0600 socket, answers, logs typed events only, and stops cleanly on SIGTERM', async () => {
    const child = spawn(process.execPath, [join(root, 'dist', 'main.js'), 'serve'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const sock = join(work, 'run', 'aegis', 'gateway.sock');
    const deadline = Date.now() + 8000;
    while (!/listening on/.test(err) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(err).toMatch(/listening on/);
    expect(lstatSync(sock).mode & 0o777).toBe(0o600);
    expect(await getStatus(sock)).toBe(200);

    // A run through the socket, with a marker that must never reach the log.
    const body = JSON.stringify({
      command: ['/usr/bin/echo', 'SECRET-PAYLOAD-MARKER'],
      env: { SECRET_ENV: 'SECRET-ENV-MARKER' },
    });
    const run = await new Promise<{ run: string }>((resolveRun, reject) => {
      const req = httpRequest(
        {
          socketPath: sock,
          method: 'POST',
          path: '/v1/runs',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            resolveRun(JSON.parse(Buffer.concat(chunks).toString()) as { run: string });
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    expect(run.run).toMatch(/^r-/);
    await new Promise((r) => setTimeout(r, 1500));

    const exited = new Promise<number | null>((resolveExit) => {
      child.on('exit', (code) => {
        resolveExit(code);
      });
    });
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(existsSync(sock)).toBe(false);

    const logFile = join(work, 'state', 'aegis', 'engine.log');
    expect(lstatSync(logFile).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(work, 'state', 'aegis')).mode & 0o777).toBe(0o700);
    const log = readFileSync(logFile, 'utf8');
    for (const line of log.trim().split('\n')) {
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }
    expect(log).toContain('run_finished');
    expect(log).not.toMatch(/SECRET/);
  });

  it('refuses to start without a policy, and without a runtime directory', () => {
    const noPolicy = aegis(['serve'], undefined, { AEGIS_POLICY_FILE: join(work, 'nope.json') });
    expect(noPolicy.status).toBe(65);
    expect(noPolicy.stderr).toMatch(/policy unavailable/);
    const noRuntime = { ...env };
    delete noRuntime['XDG_RUNTIME_DIR'];
    const r = spawnSync(process.execPath, [join(root, 'dist', 'main.js'), 'serve'], {
      encoding: 'utf8',
      env: noRuntime,
    });
    expect(r.status).toBe(65);
    expect(r.stderr).toMatch(/XDG_RUNTIME_DIR/);
  });
});
