import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { helperBuilds, request, runIn } from '../helpers/cell.js';

// Probe 4 (CLAUDE.md 8.1): run `cmd.exe /c whoami`, by name and by /mnt/c path, and exec a
// planted PE ("MZ") file. WSL interop is a binfmt_misc registration (`WSLInterop`, magic MZ,
// interpreter /init, flags P). Layers expected to stop it: no /mnt and no PATH entry for the
// Windows tools, and no /init and no binfmt_misc registration inside the cell, so the kernel
// cannot even find the interpreter (an MZ exec fails with ENOENT).

const hostCmd = '/mnt/c/Windows/System32/cmd.exe';
const interopWorks = ((): { works: boolean; whoami: string } => {
  if (!existsSync(hostCmd)) return { works: false, whoami: '' };
  const r = spawnSync(hostCmd, ['/c', 'whoami'], { encoding: 'utf8', timeout: 10_000 });
  const out = r.stdout.trim();
  return { works: r.status === 0 && out !== '', whoami: out };
})();

describe('probe 4: control', () => {
  // Without this the probe could pass on a machine where interop never worked. If interop is off
  // here the probe still runs, but the report must say its control was inconclusive.
  it.skipIf(!interopWorks.works)('interop works from the engine itself on this machine', () => {
    expect(interopWorks.whoami).not.toBe('');
  });
});

describe.each(helperBuilds())('probe 4: Windows interop ($name build)', (helper) => {
  it('cannot start a Windows process by name, by path, or by exec of a PE file', async () => {
    const script = [
      'cmd.exe /c whoami 2>&1; echo by-name-rc=$?',
      `${hostCmd} /c whoami 2>&1; echo by-path-rc=$?`,
      'powershell.exe -c whoami 2>&1; echo powershell-rc=$?',
      "printf 'MZ\\220\\000\\003\\000\\000\\000' > /tmp/planted.exe; chmod +x /tmp/planted.exe",
      '/tmp/planted.exe 2>&1; echo planted-rc=$?',
      'test -e /mnt && echo MNT-VISIBLE || echo no-mnt',
      'test -e /init && echo INIT-VISIBLE || echo no-init',
      'test -e /run/WSL && echo RUN-WSL-VISIBLE || echo no-run-wsl',
      'echo binfmt:[$(ls /proc/sys/fs/binfmt_misc 2>/dev/null | tr "\\n" " ")]',
    ].join('; ');
    const r = await runIn(helper, request(['/usr/bin/sh', '-c', script]));
    expect(r.termination, JSON.stringify(r)).toEqual({ cause: 'exit' });
    const all = r.stdout + r.stderr;
    for (const rc of ['by-name', 'by-path', 'powershell', 'planted']) {
      expect(all, rc).toMatch(new RegExp(`${rc}-rc=(126|127)`));
    }
    expect(all).not.toMatch(/MNT-VISIBLE|INIT-VISIBLE|RUN-WSL-VISIBLE/);
    expect(all).toContain('binfmt:[]');
    if (interopWorks.whoami !== '') {
      expect(all).not.toContain(interopWorks.whoami);
    }
  });
});
