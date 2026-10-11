import { describe, expect, it } from 'vitest';
import { classify, errnoName, signalName } from '../../src/collect/classify.js';
import type { StatusRecord } from '../../src/sys/status.js';

const started: StatusRecord = { kind: 'started', pid: 10 };

describe('classify', () => {
  it('normal exit carries the code', () => {
    const c = classify({
      records: [started, { kind: 'exited', code: 7 }],
      timedOut: false,
      outputLimit: null,
    });
    expect(c).toEqual({ termination: { cause: 'exit' }, exitCode: 7 });
  });

  it('a signal names the signal', () => {
    const c = classify({
      records: [started, { kind: 'signaled', signal: 11 }],
      timedOut: false,
      outputLimit: null,
    });
    expect(c.termination).toEqual({ cause: 'signal:SIGSEGV' });
    expect(c.exitCode).toBeNull();
  });

  it('timeout outranks the SIGKILL that the kill produced', () => {
    const c = classify({
      records: [started, { kind: 'signaled', signal: 9 }],
      timedOut: true,
      outputLimit: null,
    });
    expect(c.termination).toEqual({ cause: 'timeout' });
  });

  it('output limit names the stream', () => {
    const c = classify({
      records: [started, { kind: 'signaled', signal: 9 }],
      timedOut: false,
      outputLimit: 'stderr',
    });
    expect(c.termination).toEqual({ cause: 'output_limit', stream: 'stderr' });
  });

  it('a layer failure before start is isolation_unavailable and names the layer', () => {
    const c = classify({
      records: [{ kind: 'layer', layer: 'root', ok: false, errno: 1 }],
      timedOut: false,
      outputLimit: null,
    });
    expect(c.termination).toEqual({ cause: 'isolation_unavailable', layer: 'root', errno: 1 });
  });

  it('a failed execve is exec_failed, not a missing isolation layer', () => {
    const c = classify({
      records: [{ kind: 'layer', layer: 'exec', ok: false, errno: 2 }],
      timedOut: false,
      outputLimit: null,
    });
    expect(c.termination).toEqual({ cause: 'exec_failed', errno: 2 });
  });

  it('no records at all is an internal error, never a clean exit', () => {
    const c = classify({ records: [], timedOut: false, outputLimit: null });
    expect(c.termination.cause).toBe('internal_error');
  });

  it('maps numbers to names', () => {
    expect(signalName(9)).toBe('SIGKILL');
    expect(errnoName(1)).toBe('EPERM');
    expect(signalName(999)).toBe('SIG999');
  });
});
