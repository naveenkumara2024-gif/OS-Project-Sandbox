import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { helperBuilds, request, runIn } from '../helpers/cell.js';
import { createFixture, type Fixture } from './harness.js';

// Probe 2 (CLAUDE.md 8.1): read ~/.ssh/id_rsa and print $AWS_*. The fixture HOME holds decoy
// secrets and the engine's own environment holds decoy AWS variables, so a leak of either is
// visible. Layers expected to stop it: the private root (no home directory in the cell) and the
// explicit environment (nothing is inherited, CLAUDE.md 6.1 item 5).

let fixture: Fixture;
beforeEach(() => {
  fixture = createFixture();
  vi.stubEnv('HOME', fixture.home);
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'DECOY-AKIAIOSFODNN7EXAMPLE');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'DECOY-wJalrXUtnFEMI-secret');
  vi.stubEnv('AWS_SESSION_TOKEN', 'DECOY-session-token');
});
afterEach(() => {
  vi.unstubAllEnvs();
  fixture.dispose();
});

describe.each(helperBuilds())('probe 2: secrets ($name build)', (helper) => {
  it('control: the decoys are real, and readable by the engine itself', () => {
    expect(readFileSync(`${fixture.home}/.ssh/id_rsa`, 'utf8')).toContain('FAKE-PRIVATE-KEY-DECOY');
    expect(process.env['AWS_ACCESS_KEY_ID']).toContain('DECOY');
  });

  it('cannot read the key or see the AWS variables', async () => {
    const script = [
      'cat "$HOME/.ssh/id_rsa" 2>&1; echo home-rc=$?',
      'cat ~/.ssh/id_rsa 2>&1; echo tilde-rc=$?',
      `cat ${fixture.home}/.ssh/id_rsa 2>&1; echo abs-rc=$?`,
      `cat ${fixture.home}/.aws/credentials 2>&1; echo aws-file-rc=$?`,
      'cat /root/.ssh/id_rsa /home/*/.ssh/id_rsa 2>&1; echo other-rc=$?',
      'env | grep -i -E "aws|ssh|secret|token" ; echo grep-rc=$?',
      'echo "access=[$AWS_ACCESS_KEY_ID] secret=[$AWS_SECRET_ACCESS_KEY] home=[$HOME]"',
      'find /usr /etc /tmp /workspace -name "id_rsa*" -o -name credentials 2>/dev/null | head -3; echo find-done',
    ].join('; ');
    const r = await runIn(helper, request(['/usr/bin/sh', '-c', script]));
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    const all = r.stdout + r.stderr;
    expect(all).not.toContain('DECOY');
    expect(all).not.toContain('FAKE-PRIVATE-KEY');
    expect(all).toContain('access=[] secret=[] home=[]');
    for (const rc of ['home-rc', 'tilde-rc', 'abs-rc', 'aws-file-rc', 'other-rc']) {
      expect(all, rc).toMatch(new RegExp(`${rc}=[1-9]`));
    }
    expect(all).toMatch(/grep-rc=1/);
    expect(all).toMatch(/find-done\n?$/);
  });
});
