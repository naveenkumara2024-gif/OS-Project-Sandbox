import { describe, expect, it } from 'vitest';
import type { Dialer, Resolver } from '../../src/broker/broker.js';
import {
  helperBuilds,
  request,
  requireCgroupLimits,
  runIn,
  runWith,
  testGovernance,
} from '../helpers/cell.js';

// Probe 20 (CLAUDE.md 8.1): ask for 8 GB of memory and for a domain that is not on the allowlist.
// Layers expected to stop it: the ceiling policy (the request is clamped and the clamp is
// reported) and the network namespace (no interface but a down loopback, whatever the allowlist).

describe.each(helperBuilds())('probe 20: ceiling and allowlist ($name build)', (helper) => {
  it('clamps the 8 GB request, drops the domain, reports both, and leaves no network', async () => {
    const ceiling = testGovernance().ceiling;
    const r = await runIn(
      helper,
      request(
        [
          '/usr/bin/sh',
          '-c',
          'tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d " "; echo ROUTES:; tail -n +2 /proc/net/route | wc -l',
        ],
        {
          manifest: {
            limits: { memory_mb: 8192 },
            network: { mode: 'none', allow: ['evil.example'] },
          },
        },
      ),
    );
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    expect(r.limits.memory_mb).toBe(ceiling.limits.memory_mb);
    expect(r.manifest.limits.memory_mb).toBe(ceiling.limits.memory_mb);
    expect(r.manifest.network).toEqual({ mode: 'none', allow: [] });
    expect(r.clamped).toEqual([
      { field: 'limits.memory_mb', requested: 8192, granted: ceiling.limits.memory_mb },
      { field: 'network.allow', requested: 'evil.example', granted: null },
    ]);
    expect(r.network).toEqual({ mode: 'none', egress: false });
    expect(r.stdout).toBe('lo\nROUTES:\n0\n');
  });

  it('the kernel enforces the clamped limit, not the requested one', async () => {
    await requireCgroupLimits(helper);
    // A tighter ceiling than the default keeps the allocation small enough not to disturb other
    // tests: the request asks for 8 GB, the ceiling grants 256 MB, and a program that touches
    // 384 MB (more than granted, far less than asked for) must be OOM-killed.
    const governance = testGovernance({ limits: { memory_mb: 256 } });
    const r = await runWith(
      helper,
      request(
        [
          '/usr/bin/python3',
          '-c',
          'b = bytearray(384 << 20)\nfor i in range(0, len(b), 4096): b[i] = 1\nprint("survived")',
        ],
        { manifest: { limits: { memory_mb: 8192, wall_ms: 30_000, cpu_ms: 60_000 } } },
      ),
      { governance },
    );
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'oom' });
    expect(r.stdout).not.toContain('survived');
    expect(r.limits.memory_mb).toBe(256);
    expect(r.clamped).toContainEqual({ field: 'limits.memory_mb', requested: 8192, granted: 256 });
  });

  it('with the broker on, an unlisted domain is clamped away and the proxy refuses it', async () => {
    const dials: string[] = [];
    const resolver: Resolver = () => Promise.resolve(['93.184.216.34']);
    const dial: Dialer = (ip, port) => {
      dials.push(`${ip}:${String(port)}`);
      return Promise.reject(new Error('stand-in'));
    };
    const script = [
      'import socket',
      'for host in ("evil.example", "allowed.test"):',
      '    s = socket.create_connection(("127.0.0.1", 3128), timeout=5)',
      '    s.sendall(("CONNECT %s:443 HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n" % host).encode())',
      '    print(host, s.recv(200).split(b"\\r\\n")[0].decode())',
    ].join('\n');
    const r = await runWith(
      helper,
      request(['/usr/bin/python3', '-c', script], {
        manifest: { network: { mode: 'brokered', allow: ['allowed.test', 'evil.example'] } },
      }),
      {
        governance: testGovernance({ networkAllow: ['allowed.test'] }),
        broker: { resolver, dial },
      },
    );
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    expect(r.manifest.network).toEqual({ mode: 'brokered', allow: ['allowed.test'] });
    expect(r.clamped).toContainEqual({
      field: 'network.allow',
      requested: 'evil.example',
      granted: null,
    });
    expect(r.stdout).toContain('evil.example HTTP/1.1 403');
    expect(r.stdout).toContain('allowed.test HTTP/1.1 502'); // allowed by policy; the stand-in dial fails
    expect(dials).toEqual(['93.184.216.34:443']);
    expect(r.network.audit?.map((e) => [e.host, e.reason])).toEqual([
      ['evil.example', 'not_allowlisted'],
      ['allowed.test', 'connect_failed'],
    ]);
  });
});
