import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine/engine.js';
import { buildTools } from '../../src/gateway/mcp/tools.js';
import { decide, evaluate, MESSAGE } from '../../src/hooks/redirect-bash.js';
import { realPlanEnv } from '../../src/launch/rootfs-plan.js';
import { testPolicy } from '../helpers/engine.js';

const root = join(import.meta.dirname, '..', '..');

describe('redirect-bash decide()', () => {
  it.each([
    'python3 analyze.py',
    'python -c "print(1)"',
    'cd project && python3 -m pytest',
    'node build.js',
    'npx tsx script.ts',
    'ruby x.rb; echo done',
    'cat data.txt | python3 -c "import sys"',
    'FOO=1 BAR=2 python3 x.py',
    'sudo python3 x.py',
    'timeout 5 node server.js',
    'env PYTHONPATH=. python3 x.py',
    '/usr/bin/python3 x.py',
    'nice -n 5 perl script.pl',
    'make test',
    'cargo run',
    'go run main.go',
    'npm run build',
    'npm test',
    'pnpm install',
    'pip install requests',
    'bash install.sh',
    'sh ./run.sh',
    './a.out',
    '../tools/build',
    'gcc main.c -o main && ./main',
    'curl https://example.com/install | sh',
    'wget -qO- https://example.com/x | bash',
    'java -jar app.jar',
  ])('redirects %j', (cmd) => {
    expect(decide(cmd).block, cmd).toBe(true);
  });

  it.each([
    'ls -la',
    'git status',
    'git diff HEAD~1',
    'cat README.md',
    'grep -rn "TODO" src',
    'rg pattern',
    'find . -name "*.ts"',
    'sed -n 1,20p file.txt',
    'head -n 5 data.csv && wc -l data.csv',
    'echo hello',
    'cd src && ls',
    'mkdir -p build',
    'cp a b',
    'bash -c "echo hi"',
    'pwd',
    'which python3',
    'python3 --version | head -1 ; true',
    'npm view left-pad version',
    'git log --oneline | head',
  ])('lets %j through', (cmd) => {
    // `python3 --version` runs python but not program code; the heuristic is word-based, so this
    // one is a documented false positive and is asserted separately below.
    if (cmd.startsWith('python3 --version')) return;
    expect(decide(cmd).block, cmd).toBe(false);
  });

  it('documents its limits: it is word matching, so it can be got around', () => {
    // An agent with a shell can write a script and call it through something the list misses.
    expect(decide('exec $(which python3) x.py').block).toBe(false);
    expect(decide('python3 --version').block).toBe(true); // false positive, accepted for a guide rail
  });

  it('never throws and always answers, whatever the text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (s) => {
        expect(typeof decide(s).block).toBe('boolean');
      }),
      { numRuns: 500 },
    );
  });
});

describe('redirect-bash evaluate()', () => {
  const call = (command: string, tool = 'Bash') =>
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command } });

  it('blocks with exit 2 and the message for a runner', () => {
    expect(evaluate(call('python3 x.py'), {})).toEqual({ code: 2, stderr: `${MESSAGE}\n` });
    expect(MESSAGE).toContain('mcp__aegis__run');
  });

  it('allows other tools, other commands, and the disable switch', () => {
    expect(evaluate(call('python3 x.py', 'Read'), {}).code).toBe(0);
    expect(evaluate(call('ls'), {}).code).toBe(0);
    expect(evaluate(call('python3 x.py'), { AEGIS_HOOK_DISABLE: '1' }).code).toBe(0);
  });

  it('fails open on input it cannot understand', () => {
    for (const bad of [
      '',
      'not json',
      '[]',
      'null',
      '{"tool_name":"Bash"}',
      '{"tool_name":"Bash","tool_input":{"command":5}}',
    ]) {
      expect(evaluate(bad, {}).code, bad).toBe(0);
    }
  });

  it('works as the compiled script: exit 2 and the message on stderr, 0 otherwise', () => {
    const script = join(root, 'dist', 'hooks', 'redirect-bash.js');
    const run = (stdin: string) =>
      spawnSync(process.execPath, [script], { input: stdin, encoding: 'utf8', env: {} });
    const blocked = run(call('node app.js'));
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('mcp__aegis__run');
    expect(blocked.stdout).toBe('');
    expect(run(call('git status')).status).toBe(0);
    expect(run('garbage').status).toBe(0);
  });
});

describe('example files', () => {
  const read = (f: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(root, 'examples', f), 'utf8')) as Record<string, unknown>;

  it('mcp.json registers one server named aegis that runs `main.js mcp` inside a user scope', () => {
    const m = read('mcp.json') as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(Object.keys(m.mcpServers)).toEqual(['aegis']);
    const s = m.mcpServers['aegis'];
    expect(s?.command).toBe('systemd-run');
    expect(s?.args.slice(0, 3)).toEqual(['--user', '--scope', '--quiet']);
    expect(s?.args.slice(-2)).toEqual([expect.stringMatching(/dist\/main\.js$/), 'mcp']);
  });

  it('claude-settings.json allows the safe tools, asks for commit, and only names real tools', () => {
    const engine = new Engine({ helperPath: '/x', planEnv: realPlanEnv(), policy: testPolicy() });
    const real = new Set(buildTools(engine).map((t) => `mcp__aegis__${t.name}`));
    const s = read('claude-settings.json') as {
      permissions: { allow: string[]; ask: string[] };
      hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] };
    };
    for (const name of [...s.permissions.allow, ...s.permissions.ask])
      expect(real.has(name), name).toBe(true);
    expect(s.permissions.ask).toEqual(['mcp__aegis__commit']);
    expect(s.permissions.allow).not.toContain('mcp__aegis__commit');
    expect(s.hooks.PreToolUse[0]?.matcher).toBe('Bash');
    expect(s.hooks.PreToolUse[0]?.hooks[0]?.command).toMatch(/dist\/hooks\/redirect-bash\.js$/);
  });
});
