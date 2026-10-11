#!/usr/bin/env node
// Runs a command inside a cgroup delegated to the user, which the engine needs to place cells
// (docs/prompts/stage-2-limits-and-receipts.md section 4.1). If the current process already sits
// in a cgroup owned by the user it just runs the command; otherwise it runs it through
// `systemd-run --user --scope`. Development tooling only: the engine itself never uses a shell
// and never re-executes itself (that decision is deferred to Stage 5).
//
// Usage: node scripts/run-in-scope.mjs <command> [args...]
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('usage: node scripts/run-in-scope.mjs <command> [args...]');
  process.exit(64);
}

function insideDelegatedCgroup() {
  try {
    const line = readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('0::'));
    if (line === undefined) return false;
    const dir = join('/sys/fs/cgroup', line.slice(3));
    return statSync(dir).uid === process.getuid();
  } catch {
    return false;
  }
}

function run(file, args) {
  const r = spawnSync(file, args, { stdio: 'inherit', shell: false, env: process.env });
  if (r.error) {
    console.error(`run-in-scope: cannot run ${file}: ${r.error.message}`);
    return 70;
  }
  return r.status ?? (r.signal ? 128 + 15 : 70);
}

// npm puts node_modules/.bin on PATH; resolving through PATH here keeps `vitest` working.
if (insideDelegatedCgroup() || process.env.AEGIS_NO_SCOPE === '1') {
  process.exit(run(argv[0], argv.slice(1)));
}
process.exit(
  run('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--same-dir', '--', ...argv]),
);
