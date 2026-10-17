import { describe, expect, it } from 'vitest';
import { formatLogEvent, lineLogger, type LogEvent } from '../../src/util/logger.js';

describe('logger', () => {
  it('writes one JSON object per line with a timestamp and only allow-listed fields', () => {
    const lines: string[] = [];
    const log = lineLogger(
      (l) => lines.push(l),
      () => 42,
    );
    const event = {
      event: 'run_finished',
      run: 'r-1',
      manifest_sha256: 'ab',
      cause: 'exit',
      level: 4,
      // Fields that are not on the allow-list never reach the output, even if a caller adds them.
      stdout: 'SECRET PAYLOAD OUTPUT',
      env: { AWS_SECRET_ACCESS_KEY: 'x' },
      command: ['/usr/bin/cat', '/etc/shadow'],
    } as unknown as LogEvent;
    log.log(event);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    const parsed: unknown = JSON.parse(lines[0] ?? '');
    expect(parsed).toEqual({
      ts: 42,
      event: 'run_finished',
      run: 'r-1',
      manifest_sha256: 'ab',
      cause: 'exit',
      level: 4,
    });
    expect(lines[0]).not.toMatch(/SECRET|AWS|shadow/);
  });

  it('strips control characters, truncates long strings, and drops non-primitive values', () => {
    const e = {
      event: 'gateway_rejected',
      reason: `bad\nline\u0000${'x'.repeat(500)}`,
      status: Number.NaN,
      detail: { nested: 'object' },
    } as unknown as LogEvent;
    const out = JSON.parse(formatLogEvent(e, () => 1)) as Record<string, unknown>;
    expect(typeof out['reason']).toBe('string');
    expect((out['reason'] as string).length).toBe(200);
    expect(out['reason']).not.toMatch(/[\n\u0000]/);
    expect('status' in out).toBe(false);
    expect('detail' in out).toBe(false);
  });
});
