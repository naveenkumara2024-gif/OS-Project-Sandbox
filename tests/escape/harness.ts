import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// CLAUDE.md 6.5: destructive probes run only against a disposable fixture the harness creates:
// a fake HOME and a sacrificial tree under a temp directory. Never the owner's real home, project
// or Windows drives. Every probe in this directory must go through createFixture().

export interface Fixture {
  /** Root of the whole fixture, a fresh directory under the OS temp directory. */
  readonly root: string;
  /** Fake HOME with decoy secrets. */
  readonly home: string;
  readonly project: string;
  /** Hash of every file below `root` at creation time, keyed by path relative to `root`. */
  readonly snapshot: ReadonlyMap<string, string>;
  dispose(): void;
}

function hashTree(dir: string, base: string, out: Map<string, string>): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = p.slice(base.length + 1);
    if (e.isDirectory()) {
      out.set(`${rel}/`, 'dir');
      hashTree(p, base, out);
    } else if (e.isFile()) {
      out.set(rel, createHash('sha256').update(readFileSync(p)).digest('hex'));
    } else {
      out.set(rel, 'other');
    }
  }
}

export function snapshotTree(root: string): Map<string, string> {
  const m = new Map<string, string>();
  hashTree(root, root, m);
  return m;
}

export function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'aegis-fixture-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(join(home, '.aws'), { recursive: true });
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'FAKE-PRIVATE-KEY-DECOY\n');
  writeFileSync(join(home, '.aws', 'credentials'), 'aws_access_key_id=DECOY\n');
  writeFileSync(join(project, 'README.md'), '# sacrificial project\n');
  writeFileSync(join(project, 'src', 'main.txt'), 'do not lose me\n');
  return {
    root,
    home,
    project,
    snapshot: snapshotTree(root),
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
