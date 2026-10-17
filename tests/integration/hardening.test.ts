import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  helperBuilds,
  request,
  runIn,
  runWith,
  sh,
  testGovernance,
  type HelperBuild,
} from '../helpers/cell.js';

// Stage 4 hardening, proven from inside real cells: every layer is read back from /proc by the
// payload itself, not taken from the receipt. Needs a user namespace and a delegated cgroup.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let wsParent = '';
beforeEach(() => {
  wsParent = mkdtempSync(join(tmpdir(), 'aegis-hardening-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(wsParent, { recursive: true, force: true });
});

let counter = 0;
const withFile = (command: string[], extra: Record<string, unknown> = {}) =>
  request(command, {
    id: `hard-${String(process.pid)}-${String(counter++)}`,
    files: [{ path: 'seed.txt', content: 'x' }],
    ...extra,
  });

function statusOf(text: string, key: string): string {
  const line = text.split('\n').find((l) => l.startsWith(`${key}:`));
  return line === undefined ? '' : line.slice(key.length + 1).trim();
}

describe.each(helperBuilds())('hardening ($name build)', (helper) => {
  it('shows empty capability sets, no_new_privs and a seccomp filter from inside the cell', async () => {
    const r = await runWith(
      helper,
      withFile(['/usr/bin/sh', '-c', 'grep -E "^(Cap|NoNewPrivs|Seccomp|Uid)" /proc/self/status']),
      { workspaceParent: wsParent },
    );
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    for (const k of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
      expect(statusOf(r.stdout, k), k).toBe('0000000000000000');
    }
    expect(statusOf(r.stdout, 'NoNewPrivs')).toBe('1');
    expect(statusOf(r.stdout, 'Seccomp')).toBe('2');
    expect(statusOf(r.stdout, 'Uid')).toMatch(/^0\s+0\s+0\s+0$/);

    // The receipt says the same, and an overlay run with all of it reaches level 4.
    const l = r.isolation.layers;
    expect([l.caps_dropped, l.no_new_privs, l.seccomp, l.landlock, l.overlay]).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(r.isolation.level).toBe(4);
    expect(r.isolation.landlock_abi).toBeGreaterThanOrEqual(1);
  });

  it('a run without a workspace has the hardening layers too, and stops at level 2 by tier rules', async () => {
    const r = await sh(helper, 'true');
    expect(r.isolation.layers.caps_dropped).toBe(true);
    expect(r.isolation.layers.seccomp).toBe(true);
    expect(r.isolation.level).toBe(2);
  });

  it('makes init non-dumpable and unreachable: no capability, no fd, no memory, no ptrace', async () => {
    const script = [
      'import os, ctypes',
      'def t(label, fn):',
      '    try:',
      '        fn(); print(label, "ALLOWED")',
      '    except OSError as e:',
      '        print(label, "denied", e.errno)',
      't("readlink-fd4", lambda: os.readlink("/proc/1/fd/4"))',
      't("open-mem", lambda: open("/proc/1/mem", "rb").read(1))',
      't("open-environ", lambda: open("/proc/1/environ", "rb").read(1))',
      't("open-maps", lambda: open("/proc/1/maps", "rb").read(1))',
      'libc = ctypes.CDLL(None, use_errno=True)',
      'r = libc.ptrace(16, 1, 0, 0)',
      'print("ptrace-attach-init", r, ctypes.get_errno())',
      'print([l for l in open("/proc/1/status") if l.startswith(("CapEff", "CapBnd", "NoNewPrivs"))])',
    ].join('\n');
    const r = await runIn(helper, request(['/usr/bin/python3', '-c', script]));
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    expect(r.stdout).not.toContain('ALLOWED');
    expect(r.stdout).toContain('readlink-fd4 denied 13');
    expect(r.stdout).toContain('open-mem denied 13');
    expect(r.stdout).toContain('open-environ denied 13');
    expect(r.stdout).toContain('open-maps denied 13');
    expect(r.stdout).toMatch(/ptrace-attach-init -1 1\b/);
    // init itself holds no capability and has no_new_privs (readable: /proc/1/status is 0444).
    expect(r.stdout).toContain("'CapEff:\\t0000000000000000\\n'");
    expect(r.stdout).toContain("'CapBnd:\\t0000000000000000\\n'");
    expect(r.stdout).toContain("'NoNewPrivs:\\t1\\n'");
  });

  it('cannot forge init’s status records: the Stage 2 forged-exit scenario fails', async () => {
    // Before Stage 4 the payload could write "exited 0" into init's descriptor 4 through
    // /proc/1/fd/4 and change the reported outcome. The real exit status here is 3.
    const r = await sh(
      helper,
      'echo "exited 0" > /proc/1/fd/4 2>/dev/null; echo forge-rc=$?; echo "layer seccomp fail 1" > /proc/1/fd/4 2>/dev/null; exit 3',
    );
    expect(r.stdout).toMatch(/forge-rc=[1-9]/); // dash exits 2 when a redirection fails
    expect(r.termination).toEqual({ cause: 'exit' });
    expect(r.exit_code).toBe(3);
    expect(r.isolation.layers.seccomp).toBe(true);
  });

  it('runs ordinary programs unmodified under the full stack', async () => {
    const script = [
      'import threading, subprocess, os',
      'r = []',
      't = threading.Thread(target=lambda: r.append(1)); t.start(); t.join()',
      'print("thread", r)',
      'print(subprocess.run(["/usr/bin/echo", "sub"], capture_output=True, text=True).stdout.strip())',
      'pid = os.fork()',
      'if pid == 0: os._exit(3)',
      'print("fork", os.waitpid(pid, 0)[1] >> 8)',
      'open("/tmp/p", "w").write("x"); print("tmp ok")',
    ].join('\n');
    const py = await runIn(helper, request(['/usr/bin/python3', '-c', script]));
    expect(py.termination, JSON.stringify(py)).toEqual({ cause: 'exit' });
    expect(py.stdout).toBe('thread [1]\nsub\nfork 3\ntmp ok\n');

    const bash = await runIn(
      helper,
      request([
        '/usr/bin/bash',
        '-c',
        'echo a b c | tr " " "\\n" | sort | wc -l; ls /usr/bin | head -1; (sleep 0.05 &); wait; echo done',
      ]),
    );
    expect(bash.termination, JSON.stringify(bash)).toEqual({ cause: 'exit' });
    expect(bash.stdout).toMatch(/^3\n.+\ndone\n$/);

    const ls = await runIn(helper, request(['/usr/bin/ls', '/']));
    expect(ls.exit_code).toBe(0);
    const cat = await runIn(helper, request(['/usr/bin/cat', '/etc/passwd']));
    expect(cat.stdout).toContain('root:x:0:0');
  });

  it('gives the payload only the explicit environment, whatever the engine was started with', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'DECOY-AWS-KEY');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'DECOY-AWS-SECRET');
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/decoy-agent.sock');
    vi.stubEnv('HOME', '/home/decoy-home');
    const r = await runIn(helper, request(['/usr/bin/env'], { env: { MARKER: 'visible' } }));
    expect(r.termination).toEqual({ cause: 'exit' });
    expect(
      r.stdout
        .split('\n')
        .filter((l) => l !== '')
        .sort(),
    ).toEqual(['MARKER=visible', 'PATH=/usr/bin:/bin']);
    expect(r.stdout + r.stderr).not.toMatch(/DECOY|decoy|AWS_|SSH_AUTH/);
  });

  it('does not leave descriptors for the payload to find', async () => {
    const r = await sh(helper, 'ls /proc/self/fd | sort -n | tr "\\n" " "');
    for (const fd of r.stdout.trim().split(' ').map(Number)) expect(fd).toBeLessThanOrEqual(3);
  });
});

describe.each(helperBuilds())('manifest ($name build)', (helper) => {
  it('clamps a request above the ceiling and echoes the resolved manifest, hash and clamps', async () => {
    const r = await runIn(
      helper,
      request(['/usr/bin/true'], {
        manifest: {
          limits: { memory_mb: 8192, wall_ms: 3000 },
          network: { allow: ['evil.example'] },
        },
      }),
    );
    expect(r.termination).toEqual({ cause: 'exit' });
    expect(r.manifest.limits.memory_mb).toBe(2048);
    expect(r.limits.memory_mb).toBe(2048);
    expect(r.limits.wall_ms).toBe(3000);
    expect(r.manifest.network).toEqual({ mode: 'none', allow: [] });
    expect(r.clamped).toEqual([
      { field: 'limits.memory_mb', requested: 8192, granted: 2048 },
      { field: 'network.allow', requested: 'evil.example', granted: null },
    ]);
    expect(r.network).toEqual({ mode: 'none', egress: false });
    expect(r.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.ceiling_sha256).toBe(testGovernance().ceilingSha256);
    expect(r.manifest.require).toEqual(['caps_dropped', 'no_new_privs', 'seccomp']);
  });

  it('produces the same manifest hash for the same manifest, and another for another', async () => {
    const a = await runIn(helper, request(['/usr/bin/true'], { limits: { wall_ms: 2000 } }));
    const b = await runIn(
      helper,
      request(['/usr/bin/true'], { manifest: { limits: { wall_ms: 2000 } } }),
    );
    const c = await runIn(helper, request(['/usr/bin/true'], { limits: { wall_ms: 2001 } }));
    expect(a.manifest_sha256).toBe(b.manifest_sha256);
    expect(a.manifest_sha256).not.toBe(c.manifest_sha256);
  });

  it('refuses, naming the layer, when a required overlay was not established', async () => {
    const r = await runIn(
      helper,
      request(['/usr/bin/sh', '-c', 'echo RAN'], { manifest: { require: ['overlay'] } }),
    );
    expect(r.termination).toMatchObject({ cause: 'isolation_unavailable', layer: 'overlay' });
    expect(r.stdout).not.toContain('RAN');
    expect(r.manifest.require).toContain('overlay');
  });

  it('refuses a required optional cgroup layer that is missing before anything runs', async () => {
    // cgroup_cpu is delegated on this machine, so require a layer the test can make absent: the
    // fake delegation in the Stage 2 unit tests covers the missing case; here the present case
    // must simply pass.
    const r = await runIn(
      helper,
      request(['/usr/bin/true'], { manifest: { require: ['cgroup_cpu', 'cgroup_kill'] } }),
    );
    expect(r.termination).toEqual({ cause: 'exit' });
    expect(r.manifest.require).toContain('cgroup_cpu');
  });
});

function ablation(helper: HelperBuild): boolean {
  return helper.name === 'debug-asan';
}

describe.each(helperBuilds())('required Landlock ($name build)', (helper) => {
  beforeEach(() => {
    vi.stubEnv('AEGIS_TEST_UNSAFE', '1');
  });

  it.runIf(ablation(helper))(
    'refuses a run that requires landlock when it is unavailable, and the payload never runs',
    async () => {
      const req = withFile(['/usr/bin/sh', '-c', 'echo ran > /workspace/marker; echo RAN'], {
        manifest: { require: ['landlock'] },
      });
      const r = await runWith(helper, req, { workspaceParent: wsParent, ablate: ['landlock'] });
      expect(r.termination, JSON.stringify(r)).toMatchObject({
        cause: 'isolation_unavailable',
        layer: 'landlock',
      });
      expect(r.error?.layer).toBe('landlock');
      expect(r.stdout).not.toContain('RAN');
      expect(r.isolation.layers.landlock).toBe(false);
      const marker = join(wsParent, `aegis-workspace-${req.id}`, 'rw', 'upper', 'marker');
      expect(existsSync(marker)).toBe(false);
    },
  );

  it.runIf(ablation(helper))(
    'runs without landlock when it is not required, and says it is off',
    async () => {
      const r = await runWith(helper, request(['/usr/bin/sh', '-c', 'echo RAN']), {
        ablate: ['landlock'],
      });
      expect(r.termination).toEqual({ cause: 'exit' });
      expect(r.stdout).toBe('RAN\n');
      expect(r.isolation.layers.landlock).toBe(false);
      expect(r.isolation.landlock_abi).toBeNull();
      // Landlock is not in tier 4, so the other layers still stand.
      expect(r.isolation.layers.seccomp).toBe(true);
    },
  );

  it.runIf(!ablation(helper))(
    'the release build compiles the test-only switch out and rejects a spec that asks for it',
    async () => {
      const r = await runWith(helper, request(['/usr/bin/sh', '-c', 'echo RAN']), {
        ablate: ['landlock'],
      });
      expect(r.termination).toMatchObject({ cause: 'isolation_unavailable', layer: 'spec' });
      expect(r.stdout).not.toContain('RAN');
    },
  );
});

describe('command line policy handling', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-policy-'));
    // The CLI runs from dist; build it so this test exercises the current source.
    const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    const built = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
      cwd: root,
      encoding: 'utf8',
    });
    if (built.status !== 0) throw new Error(`tsc failed: ${built.stdout}${built.stderr}`);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runCli(policyFile: string): { status: number | null; json: unknown } {
    const reqFile = join(dir, 'request.json');
    writeFileSync(reqFile, JSON.stringify({ id: 'cli-policy', command: ['/usr/bin/true'] }));
    const r = spawnSync(
      process.execPath,
      [join(root, 'dist', 'main.js'), 'run', '--file', reqFile],
      {
        encoding: 'utf8',
        env: {
          AEGIS_POLICY_FILE: policyFile,
          AEGIS_CELL_BIN: helperBuilds()[0]?.path ?? '',
          PATH: process.env['PATH'] ?? '',
        },
      },
    );
    return { status: r.status, json: JSON.parse(r.stdout) as unknown };
  }

  it('refuses the run with layer "policy" when the policy file is missing or invalid', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ ceiling: { surprise: true } }));
    for (const file of [join(dir, 'missing.json'), bad]) {
      const { status, json } = runCli(file);
      expect(status).toBe(65);
      expect(json).toMatchObject({
        termination: { cause: 'isolation_unavailable', layer: 'policy' },
        error: { code: 'isolation_unavailable', layer: 'policy' },
      });
    }
  });
});
