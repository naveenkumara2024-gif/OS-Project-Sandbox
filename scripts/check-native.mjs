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

// The sources are formatted with one pinned clang-format major. A different major (the GitHub
// runner ships 18) formats some casts differently, so the check is skipped there with a notice
// instead of failing on style the pinned tool accepts. AEGIS_REQUIRE_FORMAT=1 makes a version
// mismatch an error.
const PINNED_FORMAT_MAJOR = 21;
function formatCheck() {
  const v = spawnSync('clang-format', ['--version'], { encoding: 'utf8', shell: false });
  const major = Number(/version (\d+)\./.exec(v.stdout ?? '')?.[1]);
  if (major !== PINNED_FORMAT_MAJOR) {
    console.log(
      `[check-native] clang-format ${Number.isNaN(major) ? 'unknown' : major} is not the pinned ` +
        `${PINNED_FORMAT_MAJOR}; format check ${process.env.AEGIS_REQUIRE_FORMAT === '1' ? 'FAILED' : 'skipped'}`,
    );
    return process.env.AEGIS_REQUIRE_FORMAT !== '1';
  }
  return run('clang-format', ['--dry-run', '--Werror', ...files]);
}
const formatOk = formatCheck();
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
