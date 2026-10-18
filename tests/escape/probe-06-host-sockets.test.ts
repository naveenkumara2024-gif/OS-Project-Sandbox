import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { helperBuilds, request, runIn, runWith, testGovernance } from '../helpers/cell.js';
import { createFixture, type Fixture } from './harness.js';

// Probe 6 (CLAUDE.md 8.1): connect to a host Unix socket (/var/run/docker.sock and /run/WSL/*),
// and to sockets the harness itself listens on: one in the fixture directory and one in the
// abstract namespace. Layers expected to stop it: the private root (no /var, /run, or host
// directories), the network namespace (abstract sockets belong to a network namespace, so a host
// one is invisible) and, as a second line, Landlock's abstract-socket scope.

let fixture: Fixture;
let fsServer: Server;
let abstractServer: Server;
let fsConnections = 0;
let abstractConnections = 0;
let fsPath = '';
let abstractName = '';

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

beforeEach(async () => {
  fixture = createFixture();
  fsConnections = 0;
  abstractConnections = 0;
  mkdirSync(join(fixture.root, 'sock'));
  fsPath = join(fixture.root, 'sock', 'host.sock');
  abstractName = `aegis-probe6-${String(process.pid)}-${String(Date.now())}`;
  fsServer = createServer((c) => {
    fsConnections++;
    c.destroy();
  });
  abstractServer = createServer((c) => {
    abstractConnections++;
    c.destroy();
  });
  await listen(fsServer, fsPath);
  await listen(abstractServer, `\0${abstractName}`);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([
    new Promise((r) => fsServer.close(r)),
    new Promise((r) => abstractServer.close(r)),
  ]);
  fixture.dispose();
});

const script = (fs: string, abs: string): string =>
  [
    'import socket, glob',
    `targets = ["/var/run/docker.sock", "/run/docker.sock", "/run/WSL/1_interop", "/var/run/dbus/system_bus_socket", ${JSON.stringify(fs)}, "\\0" + ${JSON.stringify(abs)}]`,
    'for t in targets:',
    '    s = socket.socket(socket.AF_UNIX)',
    '    try:',
    '        s.connect(t)',
    '        print("CONNECTED", repr(t))',
    '    except OSError as e:',
    '        print("refused", repr(t), e.errno)',
    '    finally:',
    '        s.close()',
    'print("run:", glob.glob("/run/*"), "var:", glob.glob("/var/*"), "wsl:", glob.glob("/run/WSL/*"))',
  ].join('\n');

describe('probe 6: control', () => {
  it('the harness listeners really accept connections from the engine side', async () => {
    const { connect } = await import('node:net');
    await new Promise<void>((resolve, reject) => {
      const c = connect(fsPath, () => {
        c.destroy();
        resolve();
      });
      c.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      const c = connect(`\0${abstractName}`, () => {
        c.destroy();
        resolve();
      });
      c.once('error', reject);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(fsConnections).toBe(1);
    expect(abstractConnections).toBe(1);
  });
});

describe.each(helperBuilds())('probe 6: host sockets ($name build)', (helper) => {
  it('connects to none of them, and the listeners see nothing', async () => {
    const r = await runIn(
      helper,
      request(['/usr/bin/python3', '-c', script(fsPath, abstractName)]),
    );
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    expect(r.stdout).not.toContain('CONNECTED');
    expect(r.stdout.match(/refused/g)?.length).toBe(6);
    expect(r.stdout).toContain('run: [] var: [] wsl: []');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fsConnections).toBe(0);
    expect(abstractConnections).toBe(0);
  });

  it.runIf(helper.name === 'debug-asan')(
    'without Landlock the network namespace alone still keeps the abstract socket unreachable',
    async () => {
      vi.stubEnv('AEGIS_TEST_UNSAFE', '1');
      const r = await runWith(
        helper,
        request(['/usr/bin/python3', '-c', script(fsPath, abstractName)]),
        { ablate: ['landlock'], governance: testGovernance({ requireAtLeast: [] }) },
      );
      expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
      expect(r.isolation.layers.landlock).toBe(false);
      expect(r.stdout).not.toContain('CONNECTED');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(abstractConnections).toBe(0);
    },
  );
});
