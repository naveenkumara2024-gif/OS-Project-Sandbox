import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseStatus } from '../../src/sys/status.js';

describe('parseStatus', () => {
  it('parses every record kind', () => {
    const r = parseStatus(
      'layer userns ok\nlayer root fail 1\nstarted 4242\nexited 3\nsignaled 9\n',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([
      { kind: 'layer', layer: 'userns', ok: true },
      { kind: 'layer', layer: 'root', ok: false, errno: 1 },
      { kind: 'started', pid: 4242 },
      { kind: 'exited', code: 3 },
      { kind: 'signaled', signal: 9 },
    ]);
  });

  it('parses the Stage 4 layers and the Landlock ABI record', () => {
    const r = parseStatus(
      'layer no_new_privs ok\nlayer caps_dropped ok\nlayer landlock ok\nlandlock_abi 7\nlayer seccomp fail 22\n',
    );
    expect(r.ok && r.value).toEqual([
      { kind: 'layer', layer: 'no_new_privs', ok: true },
      { kind: 'layer', layer: 'caps_dropped', ok: true },
      { kind: 'layer', layer: 'landlock', ok: true },
      { kind: 'landlock_abi', abi: 7 },
      { kind: 'layer', layer: 'seccomp', ok: false, errno: 22 },
    ]);
  });

  it('accepts an empty stream', () => {
    const r = parseStatus('');
    expect(r.ok && r.value).toEqual([]);
  });

  it.each([
    'layer userns ok',
    'layer nonsense ok\n',
    'layer userns maybe\n',
    'layer userns fail\n',
    'layer userns fail -1\n',
    'layer userns fail 1 extra\n',
    'started\n',
    'started abc\n',
    'exited 1 2\n',
    'weird 1\n',
    'layer userns ok\n\n',
    'exited 99999999999\n',
    'landlock_abi\n',
    'landlock_abi seven\n',
    'landlock_abi 7 8\n',
  ])('rejects %j', (text) => {
    expect(parseStatus(text).ok).toBe(false);
  });

  it('rejects an unbounded number of records', () => {
    expect(parseStatus('layer userns ok\n'.repeat(300)).ok).toBe(false);
  });

  it('never throws on arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        expect(typeof parseStatus(s).ok).toBe('boolean');
      }),
      { numRuns: 300 },
    );
  });
});
