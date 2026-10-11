import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { helperBuilds, sh } from '../helpers/cell.js';

// Probe 3: list and write /mnt/c/Users. Layer expected to stop it: pivot_root (no /mnt at all).
describe.each(helperBuilds())('probe 3: /mnt/c ($name build)', (helper) => {
  it('cannot list or write the Windows drive', async () => {
    // Without this the probe proves nothing: it must be run on a machine that has the drive.
    if (!existsSync('/mnt/c')) {
      throw new Error('inconclusive: /mnt/c does not exist on this host, so probe 3 cannot be run');
    }
    const marker = `/mnt/c/aegis-probe-3-${String(process.pid)}`;
    const r = await sh(
      helper,
      [
        'ls /mnt/c/Users 2>&1; echo list-rc=$?',
        `touch ${marker} 2>&1; echo touch-rc=$?`,
        'ls /mnt 2>&1; echo mnt-rc=$?',
      ].join('; '),
    );
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    expect(r.stdout).toMatch(/list-rc=[1-9]/);
    expect(r.stdout).toMatch(/touch-rc=[1-9]/);
    expect(r.stdout).toMatch(/mnt-rc=[1-9]/);
    expect(r.stdout).toContain('No such file or directory');
    expect(existsSync(marker)).toBe(false);
  });
});
