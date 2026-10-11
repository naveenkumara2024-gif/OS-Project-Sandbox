#!/usr/bin/env node
// Runs clang-format (dry run, errors on diff) and clang-tidy over native/src with an argument
// vector (no shell). Usage: node scripts/check-native.mjs
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'native', 'src');
const files = readdirSync(srcDir)
  .filter((f) => f.endsWith('.c') || f.endsWith('.h'))
  .map((f) => join(srcDir, f));
const cFiles = files.filter((f) => f.endsWith('.c'));

function run(tool, args) {
  console.log(`[check-native] ${tool} ${args.length} args`);
  const r = spawnSync(tool, args, { stdio: 'inherit', shell: false, cwd: root });
  if (r.error) {
    console.error(`[check-native] cannot run ${tool}: ${r.error.message}`);
    return false;
  }
  return r.status === 0;
}

const formatOk = run('clang-format', ['--dry-run', '--Werror', ...files]);
const tidyOk = run('clang-tidy', [...cFiles, '--', '-std=c11']);

console.log(JSON.stringify({ clangFormat: formatOk, clangTidy: tidyOk }));
process.exitCode = formatOk && tidyOk ? 0 : 1;
