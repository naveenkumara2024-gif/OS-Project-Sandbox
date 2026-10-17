#!/usr/bin/env node
// Runs clang-format (dry run, errors on diff) and clang-tidy over native/src with an argument
// vector (no shell). Usage: node scripts/check-native.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'native', 'src');
const files = readdirSync(srcDir)
  .filter((f) => f.endsWith('.c') || f.endsWith('.h'))
  .map((f) => join(srcDir, f));
const buildDir = join(root, 'native', 'build', 'test');
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
// Twice: the second pass sees the code that exists only in ablation builds (test-only switches).
const tidyOk =
  run('clang-tidy', [...cFiles, '--', '-std=c11']) &&
  run('clang-tidy', [...cFiles, '--', '-std=c11', '-DAEGIS_ENABLE_ABLATION=1']);

// The seccomp filter table test: assembles the real program and runs it through the reference
// evaluator, under ASan and UBSan. It does not need the kernel to cooperate.
mkdirSync(buildDir, { recursive: true });
const testBin = join(buildDir, 'test-filter');
const compiled = run('cc', [
  '-std=gnu11',
  '-Wall',
  '-Wextra',
  '-Wpedantic',
  '-Wconversion',
  '-Wshadow',
  '-Werror',
  '-g',
  '-fsanitize=address,undefined',
  '-fno-omit-frame-pointer',
  join(srcDir, 'test_filter.c'),
  join(srcDir, 'seccomp.c'),
  '-o',
  testBin,
]);
const filterOk = compiled && run(testBin, []);

console.log(JSON.stringify({ clangFormat: formatOk, clangTidy: tidyOk, filterTable: filterOk }));
process.exitCode = formatOk && tidyOk && filterOk ? 0 : 1;
