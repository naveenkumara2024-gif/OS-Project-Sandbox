import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The command-line tests run the compiled program (dist/main.js). Build it once, here, before any
// test file starts, so that files running in parallel never race on dist/ and always exercise the
// current source.
export default function setup(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (built.status !== 0) {
    throw new Error(`tsc -p tsconfig.build.json failed:\n${built.stdout}${built.stderr}`);
  }
}
