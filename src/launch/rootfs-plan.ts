import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { parseMountInfo } from '../probe/procfs.js';
import type { RootEntry } from '../sys/launch-spec.js';
import { SPEC_MAX_ENTRIES } from '../sys/launch-spec.js';
import { err, errFromException, ok, okVoid, type Result } from '../util/result.js';

// Amendment 1 of the Stage 1 prompt. A recursive bind of the host /usr would copy WSL's 9p and
// overlay submounts into the cell, and the kernel refuses both a non-recursive bind and an unmount
// of those copies. So /usr is rebuilt from leaf directories that contain no mount. The helper only
// executes this list and re-verifies the result; it never walks the tree.

export interface DirItem {
  readonly name: string;
  readonly kind: 'dir' | 'file' | 'symlink' | 'other';
}

export interface PlanEnv {
  readMountInfo(): Result<string>;
  listDir(path: string): Result<DirItem[]>;
  readLink(path: string): Result<string>;
}

export function realPlanEnv(): PlanEnv {
  return {
    readMountInfo(): Result<string> {
      try {
        return ok(readFileSync('/proc/self/mountinfo', 'utf8'));
      } catch (e) {
        return errFromException(e, 'read /proc/self/mountinfo');
      }
    },
    listDir(path: string): Result<DirItem[]> {
      try {
        const items = readdirSync(path, { withFileTypes: true }).map((d): DirItem => {
          let kind: DirItem['kind'] = 'other';
          if (d.isSymbolicLink()) kind = 'symlink';
          else if (d.isDirectory()) kind = 'dir';
          else if (d.isFile()) kind = 'file';
          return { name: d.name, kind };
        });
        return ok(items);
      } catch (e) {
        return errFromException(e, `readdir ${path}`);
      }
    },
    readLink(path: string): Result<string> {
      try {
        lstatSync(path);
        return ok(readlinkSync(path));
      } catch (e) {
        return errFromException(e, `readlink ${path}`);
      }
    },
  };
}

/**
 * Plans the cell's /usr. Parents come before children. Directories with no mount beneath them are
 * bound whole; directories that contain a mount are created empty and populated entry by entry,
 * skipping the mount points themselves.
 */
export function planUsr(env: PlanEnv, root = '/usr'): Result<RootEntry[]> {
  const mi = env.readMountInfo();
  if (!mi.ok) {
    return mi;
  }
  const mounts = new Set(parseMountInfo(mi.value).map((m) => m.mountPoint));
  const mountList = [...mounts];
  const hasMountBelow = (dir: string): boolean => mountList.some((m) => m.startsWith(`${dir}/`));

  const entries: RootEntry[] = [];

  const full = (): Result<never> => err('E2BIG', 'root plan exceeds the entry cap');

  const walk = (dir: string): Result<void> => {
    if (entries.length >= SPEC_MAX_ENTRIES) {
      return full();
    }
    if (!hasMountBelow(dir)) {
      entries.push({ kind: 'bind-dir', src: dir, tgt: dir });
      return okVoid;
    }
    entries.push({ kind: 'mkdir', src: '', tgt: dir });
    const list = env.listDir(dir);
    if (!list.ok) {
      return list;
    }
    const sorted = [...list.value].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of sorted) {
      const path = `${dir}/${item.name}`;
      if (mounts.has(path)) continue;
      if (item.kind === 'dir') {
        const r = walk(path);
        if (!r.ok) return r;
      } else if (item.kind === 'file') {
        if (entries.length >= SPEC_MAX_ENTRIES) return full();
        entries.push({ kind: 'bind-file', src: path, tgt: path });
      } else if (item.kind === 'symlink') {
        const link = env.readLink(path);
        if (!link.ok) return link;
        if (entries.length >= SPEC_MAX_ENTRIES) return full();
        entries.push({ kind: 'symlink', src: link.value, tgt: path });
      }
    }
    return okVoid;
  };

  const planned = walk(root);
  if (!planned.ok) {
    return planned;
  }
  return ok(entries);
}
