import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  findCgroup2Mount,
  parseControllerList,
  parseFilesystems,
  parseIntegerFile,
  parseMountInfo,
  parseSelfCgroup,
} from '../../src/probe/procfs.js';

const MOUNTINFO = [
  '22 28 0:21 / /sys rw,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs rw',
  '34 22 0:29 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:9 - cgroup2 cgroup2 rw,nsdelegate',
  '41 28 8:1 / /mnt/with\\040space rw - ext4 /dev/sda1 rw',
  'garbage line',
  '',
].join('\n');

describe('parseMountInfo', () => {
  it('parses well-formed lines and skips malformed ones', () => {
    const entries = parseMountInfo(MOUNTINFO);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ mountPoint: '/sys', fsType: 'sysfs', source: 'sysfs' });
  });

  it('decodes octal escapes in paths', () => {
    const entries = parseMountInfo(MOUNTINFO);
    expect(entries[2]?.mountPoint).toBe('/mnt/with space');
  });

  it('finds the cgroup2 mount point', () => {
    expect(findCgroup2Mount(parseMountInfo(MOUNTINFO))).toBe('/sys/fs/cgroup');
  });

  it('reports no cgroup2 mount when none is listed', () => {
    expect(findCgroup2Mount(parseMountInfo(''))).toBeNull();
  });
});

describe('parseSelfCgroup', () => {
  it('reads the unified hierarchy path', () => {
    const r = parseSelfCgroup('0::/user.slice/user-1000.slice/session-3.scope\n');
    expect(r).toEqual({ v2Path: '/user.slice/user-1000.slice/session-3.scope', v1Lines: 0 });
  });

  it('counts v1 lines and still finds the v2 path', () => {
    const r = parseSelfCgroup('12:memory:/foo\n0::/bar\n');
    expect(r).toEqual({ v2Path: '/bar', v1Lines: 1 });
  });

  it('keeps colons inside the path', () => {
    expect(parseSelfCgroup('0::/a:b\n').v2Path).toBe('/a:b');
  });

  it('returns null v2 path for empty input', () => {
    expect(parseSelfCgroup('')).toEqual({ v2Path: null, v1Lines: 0 });
  });
});

describe('parseControllerList', () => {
  it('splits on whitespace and ignores empties', () => {
    expect(parseControllerList('cpuset cpu io memory pids\n')).toEqual([
      'cpuset',
      'cpu',
      'io',
      'memory',
      'pids',
    ]);
    expect(parseControllerList('\n')).toEqual([]);
  });
});

describe('parseFilesystems', () => {
  it('returns names with and without the nodev marker', () => {
    const names = parseFilesystems('nodev\tsysfs\nnodev\toverlay\n\text4\n');
    expect(names).toEqual(['sysfs', 'overlay', 'ext4']);
  });
});

describe('parseIntegerFile', () => {
  it('parses integers and rejects everything else', () => {
    expect(parseIntegerFile('63548\n')).toBe(63548);
    expect(parseIntegerFile('0')).toBe(0);
    expect(parseIntegerFile('max')).toBeNull();
    expect(parseIntegerFile('')).toBeNull();
    expect(parseIntegerFile('1e9')).toBeNull();
  });
});

describe('parsers never throw on arbitrary text', () => {
  it.each([
    ['parseMountInfo', parseMountInfo],
    ['findCgroup2Mount', (s: string) => findCgroup2Mount(parseMountInfo(s))],
    ['parseSelfCgroup', parseSelfCgroup],
    ['parseControllerList', parseControllerList],
    ['parseFilesystems', parseFilesystems],
    ['parseIntegerFile', parseIntegerFile],
  ] as const)('%s', (_name, fn) => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        fn(s);
        return true;
      }),
    );
  });
});
