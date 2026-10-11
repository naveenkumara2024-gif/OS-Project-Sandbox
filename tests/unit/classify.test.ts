import { describe, expect, it } from 'vitest';
import { classify, errnoName, signalName } from '../../src/collect/classify.js';
import type { StatusRecord } from '../../src/sys/status.js';

const started: StatusRecord = { kind: 'started', pid: 10 };

describe('classify', () => {
  it('normal exit carries the code', () => {
    const c = classify({
      records: [started, { kind: 'exited', code: 7 }],
      supervisorKill: null,
      oomKills: 0,
      pidsMaxHits: 0,
    });
    expect(c).toMatchObject({ termination: { cause: 'exit' }, exitCode: 7 });
  });

  it('a signal names the signal', () => {
    const c = classify({
      records: [started, { kind: 'signaled', signal: 11 }],
      supervisorKill: null,
      oomKills: 0,
      pidsMaxHits: 0,
    });
    expect(c.termination).toEqual({ cause: 'signal:SIGSEGV' });
    expect(c.exitCode).toBeNull();
  });

  it('timeout outranks the SIGKILL that the kill produced', () => {
    const c = classify({
      records: [started, { kind: 'signaled', signal: 9 }],
      supervisorKill: { kind: 'timeout', clock: 'wall' },
      oomKills: 0,
      pidsMaxHits: 0,
    });
    expect(c.termination).toEqual({ cause: 'timeout', clock: 'wall' });
  });

  it('output limit names the stream', () => {
    const c = classify({
      records: [started, { kind: 'signaled', signal: 9 }],
      supervisorKill: { kind: 'output_limit', stream: 'stderr' },
      oomKills: 0,
      pidsMaxHits: 0,
    });
    expect(c.termination).toEqual({ cause: 'output_limit', stream: 'stderr' });
  });

  it('a layer failure before start is isolation_unavailable and names the layer', () => {
    const c = classify({
      records: [{ kind: 'layer', layer: 'root', ok: false, errno: 1 }],
      supervisorKill: null,
      oomKills: 0,
      pidsMaxHits: 0,
    });
    expect(c.termination).toEqual({ cause: 'isolation_unavailable', layer: 'root', errno: 1 });
  });

  it('a failed execve is exec_failed, not a missing isolation layer', () => {
    const c = classify({
      records: [{ kind: 'layer', layer: 'exec', ok: false, errno: 2 }],
      supervisorKill: null,
      oomKills: 0,
      pidsMaxHits: 0,
    });
    expect(c.termination).toEqual({ cause: 'exec_failed', errno: 2 });
  });

  it('a timeout that ended the cell before the payload started is still a timeout', () => {
    const c = classify({
      records: [{ kind: 'layer', layer: 'idmap', ok: false, errno: 13 }],
      supervisorKill: { kind: 'timeout', clock: 'wall' },
      oomKills: 0,
      pidsMaxHits: 0,
    });
    expect(c.termination).toEqual({ cause: 'timeout', clock: 'wall' });
  });

  it('no records at all is an internal error, never a clean exit', () => {
    const c = classify({ records: [], supervisorKill: null, oomKills: 0, pidsMaxHits: 0 });
    expect(c.termination.cause).toBe('internal_error');
  });

  const run: StatusRecord[] = [started];

  it('a kernel OOM kill is oom and is listed as a limit hit', () => {
    const c = classify({
      records: run,
      supervisorKill: null,
      oomKills: 1,
      pidsMaxHits: 0,
    });
    expect(c.termination).toEqual({ cause: 'oom' });
    expect(c.limitsHit).toEqual(['memory']);
  });

  it('a pids kill by the supervisor is pids_limit even though the payload died by SIGKILL', () => {
    const c = classify({
      records: [started, { kind: 'signaled', signal: 9 }],
      supervisorKill: { kind: 'pids_limit' },
      oomKills: 0,
      pidsMaxHits: 4,
    });
    expect(c.termination).toEqual({ cause: 'pids_limit' });
    expect(c.limitsHit).toEqual(['pids']);
  });

  it('a CPU budget kill is a timeout on the cpu clock', () => {
    const c = classify({
      records: run,
      supervisorKill: { kind: 'timeout', clock: 'cpu' },
      oomKills: 0,
      pidsMaxHits: 0,
    });
    expect(c.termination).toEqual({ cause: 'timeout', clock: 'cpu' });
    expect(c.limitsHit).toEqual(['cpu']);
  });

  it('a full capped tmpfs with a failing payload is disk_limit', () => {
    const c = classify({
      records: [started, { kind: 'exited', code: 1 }, { kind: 'full', path: '/tmp' }],
      supervisorKill: null,
      oomKills: 0,
      pidsMaxHits: 0,
    });
    expect(c.termination).toEqual({ cause: 'disk_limit', path: '/tmp' });
    expect(c.exitCode).toBe(1);
  });

  it('a full tmpfs does not turn a clean exit into disk_limit', () => {
    const c = classify({
      records: [started, { kind: 'exited', code: 0 }, { kind: 'full', path: '/tmp' }],
      supervisorKill: null,
      oomKills: 0,
      pidsMaxHits: 0,
    });
    expect(c.termination).toEqual({ cause: 'exit' });
    expect(c.limitsHit).toEqual(['disk']);
  });

  it('keeps the precedence: supervisor kill over oom over disk over signal over exit', () => {
    const base = [
      started,
      { kind: 'signaled', signal: 9 },
      { kind: 'full', path: '/tmp' },
    ] as const;
    const mk = (kill: Parameters<typeof classify>[0]['supervisorKill'], oom: number) =>
      classify({ records: base, supervisorKill: kill, oomKills: oom, pidsMaxHits: 0 }).termination
        .cause;
    expect(mk({ kind: 'timeout', clock: 'wall' }, 1)).toBe('timeout');
    expect(mk(null, 1)).toBe('oom');
    expect(mk(null, 0)).toBe('disk_limit');
  });

  it('maps numbers to names', () => {
    expect(signalName(9)).toBe('SIGKILL');
    expect(errnoName(1)).toBe('EPERM');
    expect(signalName(999)).toBe('SIG999');
  });
});
