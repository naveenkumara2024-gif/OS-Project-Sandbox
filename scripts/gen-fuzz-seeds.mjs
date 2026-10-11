#!/usr/bin/env node
// Writes seed inputs for the launch-spec fuzz target into tests/fuzz/corpus/spec using the real
// TypeScript encoder, so seeds always match the wire format. Requires `npm run build` first.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { encodeLaunchSpec } = await import(join(root, 'dist', 'sys', 'launch-spec.js'));

const base = {
  argv: ['/usr/bin/echo', 'hi'],
  env: ['PATH=/usr/bin:/bin'],
  rootMountpoint: '/tmp/aegis-cell-seed/root',
  hostname: 'aegis',
  rootTmpfsBytes: 64 * 1024 * 1024,
  tmpTmpfsBytes: 16 * 1024 * 1024,
  entries: [],
  maskFiles: [],
  maskDirs: [],
};
const seeds = {
  minimal: base,
  with_entries: {
    ...base,
    entries: [
      { kind: 'mkdir', src: '', tgt: '/usr' },
      { kind: 'bind-dir', src: '/usr/bin', tgt: '/usr/bin' },
      { kind: 'bind-file', src: '/usr/lib/os-release', tgt: '/usr/lib/os-release' },
      { kind: 'symlink', src: 'usr/lib', tgt: '/usr/lib64' },
    ],
    maskFiles: ['/usr/bin/node'],
    maskDirs: ['/usr/include/node'],
  },
  many_args: {
    ...base,
    argv: ['/bin/sh', ...Array.from({ length: 60 }, (_, i) => `arg${String(i)}`)],
  },
};

const out = join(root, 'tests', 'fuzz', 'corpus', 'spec');
mkdirSync(out, { recursive: true });
for (const [name, spec] of Object.entries(seeds)) {
  const r = encodeLaunchSpec(spec);
  if (!r.ok) throw new Error(`${name}: ${r.error.context}`);
  writeFileSync(join(out, `seed-${name}`), r.value);
}
writeFileSync(
  join(out, 'seed-bad-magic'),
  Buffer.from('NOPE\x01\x00\x00\x00\x0c\x00\x00\x00', 'latin1'),
);
writeFileSync(
  join(out, 'seed-header-only'),
  Buffer.from('AEGS\x01\x00\x00\x00\x0c\x00\x00\x00', 'latin1'),
);
console.log(`seeds written to ${out}`);
