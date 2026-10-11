#!/usr/bin/env node
// Builds the native helper `aegis-cell` by invoking the C compiler with an argument vector (no
// shell). Usage: node scripts/build-native.mjs [release|debug-asan|all] [--cc=gcc|clang]
//
// Output: native/build/<mode>/aegis-cell. The release build is attempted as static-pie, then as
// plain static; if both fail it falls back to a dynamic build and says so loudly, because the
// in-cell helper must not depend on host shared libraries (CLAUDE.md 2.1).
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sources = ['main.c', 'sys.c', 'probe.c'].map((f) => join(root, 'native', 'src', f));

// -U before -D: some distributions predefine _FORTIFY_SOURCE, and -Werror would reject the clash.
const common = [
  '-std=c11',
  '-D_GNU_SOURCE',
  '-Wall',
  '-Wextra',
  '-Wpedantic',
  '-Wconversion',
  '-Wshadow',
  '-Werror',
  '-fstack-protector-strong',
  '-U_FORTIFY_SOURCE',
  '-D_FORTIFY_SOURCE=2',
  '-fPIE',
];
const hardenedLink = ['-Wl,-z,relro,-z,now'];

const modes = {
  release: {
    compile: ['-O2'],
    links: [
      { label: 'static-pie', flags: ['-static-pie'] },
      { label: 'static', flags: ['-static', '-no-pie'] },
      { label: 'DYNAMIC (static link failed; not acceptable inside a cell)', flags: ['-pie'] },
    ],
  },
  'debug-asan': {
    // ASan does not support static glibc, so this build is dynamic by design.
    compile: ['-O1', '-g', '-fno-omit-frame-pointer', '-fsanitize=address,undefined'],
    links: [{ label: 'dynamic-pie (asan)', flags: ['-pie', '-fsanitize=address,undefined'] }],
  },
};

function parseArgs(argv) {
  let cc = process.env.AEGIS_CC ?? 'cc';
  const wanted = [];
  for (const arg of argv) {
    if (arg.startsWith('--cc=')) {
      cc = arg.slice('--cc='.length);
    } else if (arg === 'all') {
      wanted.push(...Object.keys(modes));
    } else if (arg in modes) {
      wanted.push(arg);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!/^[A-Za-z0-9_.+-]+$/.test(cc)) {
    throw new Error(`refusing compiler name with unexpected characters: ${cc}`);
  }
  return { cc, wanted: wanted.length > 0 ? [...new Set(wanted)] : Object.keys(modes) };
}

function run(cc, args) {
  const r = spawnSync(cc, args, { stdio: 'inherit', shell: false });
  if (r.error) {
    throw new Error(`failed to run ${cc}: ${r.error.message}`);
  }
  return r.status === 0;
}

function build(cc, name) {
  const mode = modes[name];
  const outDir = join(root, 'native', 'build', name);
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'aegis-cell');
  for (const link of mode.links) {
    const args = [...common, ...mode.compile, ...sources, '-o', out, ...hardenedLink, ...link.flags];
    console.log(`[build-native] ${name}: ${cc} (${link.label})`);
    if (run(cc, args)) {
      console.log(`[build-native] ${name}: built ${out} as ${link.label}`);
      return { name, linking: link.label, out };
    }
    console.warn(`[build-native] ${name}: link attempt "${link.label}" failed`);
  }
  throw new Error(`${name}: all link attempts failed`);
}

try {
  const { cc, wanted } = parseArgs(process.argv.slice(2));
  const results = wanted.map((name) => build(cc, name));
  console.log(JSON.stringify({ cc, results }, null, 2));
} catch (e) {
  console.error(`[build-native] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
