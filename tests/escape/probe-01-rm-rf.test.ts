import { existsSync, statSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { helperBuilds, sh } from '../helpers/cell.js';
import { createFixture, snapshotTree } from './harness.js';

// Probe 1 (CLAUDE.md 8.1): `rm -rf /` then check the fixture files.
// Layer expected to stop it: mount namespace + pivot_root (the fixture is not in the cell's tree),
// backed by the verified read-only /usr binds.
const fixture = createFixture();
afterAll(() => {
  fixture.dispose();
});

describe.each(helperBuilds())('probe 1: rm -rf / ($name build)', (helper) => {
  it('leaves the fixture and the host /usr untouched', async () => {
    const usrBefore = statSync('/usr/bin/sh').size;
    const r = await sh(
      helper,
      [
        'rm -rf --no-preserve-root / 2>/dev/null',
        `rm -rf --no-preserve-root ${fixture.home} ${fixture.project} 2>/dev/null`,
        `test -e ${fixture.root} && echo FIXTURE-VISIBLE || echo fixture-absent`,
        `cat ${fixture.home}/.ssh/id_rsa 2>&1`,
        'ls /',
      ].join('; '),
    );
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });

    // The control: the probe really ran inside a cell that could not see the fixture.
    expect(r.stdout).toContain('fixture-absent');
    expect(r.stdout).not.toContain('FIXTURE-VISIBLE');
    expect(r.stdout).not.toContain('FAKE-PRIVATE-KEY-DECOY');

    // The finding would be here: any change to the fixture or to the host's /usr.
    expect(snapshotTree(fixture.root)).toEqual(new Map(fixture.snapshot));
    expect(existsSync('/usr/bin/sh')).toBe(true);
    expect(statSync('/usr/bin/sh').size).toBe(usrBefore);
    expect(existsSync('/usr/bin/node')).toBe(true);
    expect(statSync('/usr/bin/node').size).toBeGreaterThan(0);
  });
});
