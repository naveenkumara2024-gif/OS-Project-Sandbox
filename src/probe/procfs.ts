// Pure parsers for the /proc and cgroup text formats the probe reads. They take text, return data,
// never throw and never touch the filesystem, so they can be tested with canned fixtures and
// property tests (CLAUDE.md 7).

export interface MountInfoEntry {
  readonly mountPoint: string;
  readonly fsType: string;
  readonly source: string;
}

/** The kernel escapes space, tab, newline and backslash in mountinfo paths as \ooo octal. */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(parseInt(octal, 8)),
  );
}

/**
 * Parses /proc/self/mountinfo (proc(5)): `id parent maj:min root mountpoint opts [optional...] -
 * fstype source superopts`. Malformed lines are skipped.
 */
export function parseMountInfo(text: string): MountInfoEntry[] {
  const entries: MountInfoEntry[] = [];
  for (const line of text.split('\n')) {
    const fields = line.split(' ');
    const sep = fields.indexOf('-');
    if (sep < 6) continue;
    const mountPoint = fields[4];
    const fsType = fields[sep + 1];
    const source = fields[sep + 2];
    if (mountPoint === undefined || fsType === undefined || source === undefined) continue;
    entries.push({
      mountPoint: unescapeMountField(mountPoint),
      fsType,
      source: unescapeMountField(source),
    });
  }
  return entries;
}

/** Mount point of the first cgroup2 filesystem, or null when cgroup v2 is not mounted. */
export function findCgroup2Mount(entries: readonly MountInfoEntry[]): string | null {
  for (const entry of entries) {
    if (entry.fsType === 'cgroup2') return entry.mountPoint;
  }
  return null;
}

export interface SelfCgroup {
  /** Path of this process in the unified hierarchy (the `0::` line), or null if absent. */
  readonly v2Path: string | null;
  /** Number of cgroup v1 hierarchy lines, which indicates a hybrid or legacy layout. */
  readonly v1Lines: number;
}

/** Parses /proc/self/cgroup (cgroups(7)): `hierarchy-ID:controller-list:path`. */
export function parseSelfCgroup(text: string): SelfCgroup {
  let v2Path: string | null = null;
  let v1Lines = 0;
  for (const line of text.split('\n')) {
    const first = line.indexOf(':');
    if (first < 0) continue;
    const second = line.indexOf(':', first + 1);
    if (second < 0) continue;
    const hierarchy = line.slice(0, first);
    const controllers = line.slice(first + 1, second);
    const path = line.slice(second + 1);
    if (hierarchy === '0' && controllers === '') {
      v2Path = path;
    } else {
      v1Lines += 1;
    }
  }
  return { v2Path, v1Lines };
}

/** Parses cgroup.controllers and cgroup.subtree_control: space-separated controller names. */
export function parseControllerList(text: string): string[] {
  return text.split(/\s+/).filter((name) => name.length > 0);
}

/** Parses /proc/filesystems: `nodev<TAB>name` or `<TAB>name`. Returns the filesystem names. */
export function parseFilesystems(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const tokens = line.split(/\s+/).filter((t) => t.length > 0);
    const name = tokens[tokens.length - 1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** Parses a /proc/sys style file holding one integer. Returns null for anything else. */
export function parseIntegerFile(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d{1,15}$/.test(trimmed)) return null;
  return Number(trimmed);
}
