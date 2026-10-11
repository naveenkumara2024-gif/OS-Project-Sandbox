import { describe, expect, it } from 'vitest';
import { runBounded, type RunOptions } from '../../src/sys/run-bounded.js';

// The current Node binary is an absolute path that exists on every platform running the tests, so
// these tests need no other executable.
const NODE = process.execPath;

function node(script: string, extra: Partial<RunOptions> = {}, args: string[] = []): RunOptions {
  return {
    file: NODE,
    args: ['-e', script, ...args],
    env: {},
    timeoutMs: 10_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
    ...extra,
  };
}

describe('runBounded', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const r = await runBounded(
      node("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.exitCode).toBe(3);
    expect(r.value.stdout.toString()).toBe('out');
    expect(r.value.stderr.toString()).toBe('err');
    expect(r.value.timedOut).toBe(false);
    expect(r.value.outputLimit).toBeNull();
  });

  it('kills the child on wall-clock timeout', async () => {
    const r = await runBounded(node('setTimeout(() => {}, 30000)', { timeoutMs: 200 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.timedOut).toBe(true);
    expect(r.value.exitCode).toBeNull();
    expect(r.value.signal).toBe('SIGKILL');
  });

  it('enforces the stdout cap and kills the child', async () => {
    const r = await runBounded(
      node("setInterval(() => process.stdout.write('x'.repeat(4096)), 1)", {
        maxStdoutBytes: 1000,
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outputLimit).toBe('stdout');
    expect(r.value.stdout.length).toBe(1000);
    expect(r.value.signal).toBe('SIGKILL');
  });

  it('does not interpret shell metacharacters in arguments', async () => {
    const hostile = '; echo pwned && $(whoami) `id`';
    const r = await runBounded(node('process.stdout.write(process.argv[1])', {}, [hostile]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stdout.toString()).toBe(hostile);
  });

  it('passes only the explicit environment', async () => {
    process.env['AEGIS_TEST_SECRET'] = 'leak';
    try {
      const r = await runBounded(
        node('process.stdout.write(JSON.stringify(Object.keys(process.env)))', {
          env: { AEGIS_TEST_ONLY: '1' },
        }),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const keys: unknown = JSON.parse(r.value.stdout.toString());
      expect(keys).toContain('AEGIS_TEST_ONLY');
      expect(keys).not.toContain('AEGIS_TEST_SECRET');
      expect(keys).not.toContain('HOME');
    } finally {
      delete process.env['AEGIS_TEST_SECRET'];
    }
  });

  it('reports a missing binary as a value', async () => {
    const r = await runBounded({
      file: '/nonexistent/aegis-binary',
      args: [],
      env: {},
      timeoutMs: 1000,
      maxStdoutBytes: 10,
      maxStderrBytes: 10,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('ENOENT');
  });

  it('rejects a relative binary path', async () => {
    const r = await runBounded({
      file: 'node',
      args: [],
      env: {},
      timeoutMs: 1000,
      maxStdoutBytes: 10,
      maxStderrBytes: 10,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('EINVAL');
  });
});
