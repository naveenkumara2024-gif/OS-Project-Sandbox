import { accessSync, constants, existsSync, readdirSync, readFileSync, statfsSync } from 'node:fs';
import { arch, constants as osConstants, release } from 'node:os';
import { posix } from 'node:path';
import {
  checkExecutable,
  locateHelper,
  moduleDir,
  NATIVE_FACT_KEYS,
  runHelperProbe,
  type HelperProbe,
  type NativeFact,
} from '../sys/helper.js';
import { errFromException, ok, okVoid, type Result } from '../util/result.js';
import {
  findCgroup2Mount,
  parseControllerList,
  parseFilesystems,
  parseIntegerFile,
  parseMountInfo,
  parseSelfCgroup,
} from './procfs.js';

// Stage 0 reports facts only (CLAUDE.md 3.1, docs/prompts/stage-0-scaffold.md section 4): what the
// kernel answered, where the answer came from, and the error code if there was one. No isolation
// level and no pass/fail verdict is computed here; that is Stage 2.

export type FactValue = string | number | boolean | null | readonly string[];

export interface Fact {
  readonly value: FactValue;
  /** File, syscall or API the value came from, or why the fact was skipped. */
  readonly source: string;
  /** errno name (for example "ENOENT") when the read or call failed, otherwise null. */
  readonly errno: string | null;
}

export const PROBE_FACT_KEYS = [
  'kernel.release',
  'kernel.version',
  'kernel.arch',
  'node.version',
  'process.uid',
  'process.gid',
  'wsl.osrelease_marker',
  'userns.max_user_namespaces',
  'cgroup2.mount_point',
  'cgroup.self_path',
  'cgroup.v1_lines',
  'cgroup.controllers',
  'cgroup.subtree_control',
  'cgroup.own_dir_writable',
  'cgroup.kill_present',
  'cgroup.memory_peak_present',
  'fs.overlay_listed',
  'cwd.statfs_type',
  'mnt_c.present',
  'wsl.interop_entries',
  'native.helper_path',
  'native.helper_available',
  ...NATIVE_FACT_KEYS.map((k) => `native.${k}` as const),
] as const;

export type ProbeFactKey = (typeof PROBE_FACT_KEYS)[number];

export interface ProbeReport {
  readonly schema: 1;
  readonly tool: 'aegis';
  readonly generated_at: string;
  readonly facts: Readonly<Record<ProbeFactKey, Fact>>;
}

export interface HelperOutcome {
  readonly path: string | null;
  readonly source: string | null;
  readonly result: Result<HelperProbe>;
}

/** Everything the probe needs from the outside world, injectable so tests use canned data. */
export interface ProbeEnv {
  readText(path: string): Result<string>;
  listDir(path: string): Result<string[]>;
  exists(path: string): boolean;
  isWritable(path: string): Result<void>;
  statfsType(path: string): Result<number>;
  osRelease(): string;
  arch(): string;
  nodeVersion(): string;
  uid(): number | null;
  gid(): number | null;
  cwd(): string;
  now(): Date;
  helperProbe(): Promise<HelperOutcome>;
}

const ERRNO_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(osConstants.errno).map(([name, num]): [number, string] => [num, name]),
);

/** Maps a raw errno number from the native helper to its name, or `ERRNO_<n>` if unknown. */
export function errnoName(n: number): string {
  return ERRNO_NAMES.get(n) ?? `ERRNO_${String(n)}`;
}

function plain(value: FactValue, source: string): Fact {
  return { value, source, errno: null };
}

function skipped(reason: string): Fact {
  return { value: null, source: reason, errno: null };
}

function fromResult<T>(source: string, r: Result<T>, map: (t: T) => FactValue): Fact {
  return r.ok
    ? { value: map(r.value), source, errno: null }
    : { value: null, source, errno: r.error.code };
}

function fromNative(fact: NativeFact): Fact {
  return {
    value: fact.value,
    source: fact.source,
    errno: fact.errno === null ? null : errnoName(fact.errno),
  };
}

export async function collectProbe(env: ProbeEnv): Promise<ProbeReport> {
  const facts: Record<string, Fact> = {};
  const add = (key: ProbeFactKey, fact: Fact): void => {
    facts[key] = fact;
  };

  // Identity and kernel.
  add('kernel.release', plain(env.osRelease(), 'os.release()'));
  add(
    'kernel.version',
    fromResult('/proc/version', env.readText('/proc/version'), (t) => t.trim()),
  );
  add('kernel.arch', plain(env.arch(), 'os.arch()'));
  add('node.version', plain(env.nodeVersion(), 'process.versions.node'));
  add('process.uid', plain(env.uid(), 'process.getuid()'));
  add('process.gid', plain(env.gid(), 'process.getgid()'));
  // Informational only: never used to infer support (CLAUDE.md 3.1).
  add(
    'wsl.osrelease_marker',
    fromResult('/proc/sys/kernel/osrelease', env.readText('/proc/sys/kernel/osrelease'), (t) =>
      /microsoft/i.test(t),
    ),
  );
  add(
    'userns.max_user_namespaces',
    fromResult(
      '/proc/sys/user/max_user_namespaces',
      env.readText('/proc/sys/user/max_user_namespaces'),
      parseIntegerFile,
    ),
  );

  // cgroup v2.
  const mountinfo = env.readText('/proc/self/mountinfo');
  const mountPoint = mountinfo.ok ? findCgroup2Mount(parseMountInfo(mountinfo.value)) : null;
  add(
    'cgroup2.mount_point',
    fromResult('/proc/self/mountinfo (fstype cgroup2)', mountinfo, (t) =>
      findCgroup2Mount(parseMountInfo(t)),
    ),
  );
  const selfCgroup = env.readText('/proc/self/cgroup');
  const selfPath = selfCgroup.ok ? parseSelfCgroup(selfCgroup.value).v2Path : null;
  add(
    'cgroup.self_path',
    fromResult('/proc/self/cgroup (0:: line)', selfCgroup, (t) => parseSelfCgroup(t).v2Path),
  );
  add(
    'cgroup.v1_lines',
    fromResult(
      '/proc/self/cgroup (v1 hierarchy lines)',
      selfCgroup,
      (t) => parseSelfCgroup(t).v1Lines,
    ),
  );

  const dir = mountPoint !== null && selfPath !== null ? posix.join(mountPoint, selfPath) : null;
  if (dir === null) {
    const why = 'skipped: cgroup v2 mount point or own cgroup path unavailable';
    add('cgroup.controllers', skipped(why));
    add('cgroup.subtree_control', skipped(why));
    add('cgroup.own_dir_writable', skipped(why));
    add('cgroup.kill_present', skipped(why));
    add('cgroup.memory_peak_present', skipped(why));
  } else {
    const controllers = posix.join(dir, 'cgroup.controllers');
    const subtree = posix.join(dir, 'cgroup.subtree_control');
    const procs = posix.join(dir, 'cgroup.procs');
    add(
      'cgroup.controllers',
      fromResult(controllers, env.readText(controllers), parseControllerList),
    );
    add('cgroup.subtree_control', fromResult(subtree, env.readText(subtree), parseControllerList));
    // cgroup.procs is the file a delegated owner must be able to write to move processes in.
    add('cgroup.own_dir_writable', writableFact(`access(${procs}, W_OK)`, env.isWritable(procs)));
    const killPath = posix.join(dir, 'cgroup.kill');
    const peakPath = posix.join(dir, 'memory.peak');
    add('cgroup.kill_present', plain(env.exists(killPath), `exists(${killPath})`));
    add('cgroup.memory_peak_present', plain(env.exists(peakPath), `exists(${peakPath})`));
  }

  // Filesystems and the WSL surface.
  add(
    'fs.overlay_listed',
    fromResult('/proc/filesystems', env.readText('/proc/filesystems'), (t) =>
      parseFilesystems(t).includes('overlay'),
    ),
  );
  add(
    'cwd.statfs_type',
    fromResult('statfs(cwd).type', env.statfsType(env.cwd()), (n) => n),
  );
  add('mnt_c.present', plain(env.exists('/mnt/c'), 'exists(/mnt/c)'));
  add(
    'wsl.interop_entries',
    fromResult('/proc/sys/fs/binfmt_misc', env.listDir('/proc/sys/fs/binfmt_misc'), (names) =>
      names.filter((n) => n.startsWith('WSLInterop')).sort(),
    ),
  );

  // Native helper.
  const helper = await env.helperProbe();
  add('native.helper_path', plain(helper.path, helper.source ?? 'locateHelper'));
  add(
    'native.helper_available',
    helper.result.ok
      ? plain(true, 'spawn aegis-cell probe')
      : {
          value: false,
          source: `spawn aegis-cell probe: ${helper.result.error.context}`,
          errno: helper.result.error.code,
        },
  );
  for (const key of NATIVE_FACT_KEYS) {
    add(
      `native.${key}`,
      helper.result.ok
        ? fromNative(helper.result.value.facts[key])
        : skipped('skipped: native helper unavailable'),
    );
  }

  return {
    schema: 1,
    tool: 'aegis',
    generated_at: env.now().toISOString(),
    facts: facts as Record<ProbeFactKey, Fact>,
  };
}

function writableFact(source: string, r: Result<void>): Fact {
  return r.ok ? plain(true, source) : { value: false, source, errno: r.error.code };
}

/** Probe environment backed by the real machine. */
export function realProbeEnv(): ProbeEnv {
  const linux = process.platform === 'linux';
  return {
    readText(path) {
      try {
        return ok(readFileSync(path, 'utf8'));
      } catch (e) {
        return errFromException(e, `read ${path}`);
      }
    },
    listDir(path) {
      try {
        return ok(readdirSync(path));
      } catch (e) {
        return errFromException(e, `readdir ${path}`);
      }
    },
    exists: (path) => existsSync(path),
    isWritable(path) {
      try {
        accessSync(path, constants.W_OK);
        return okVoid;
      } catch (e) {
        return errFromException(e, `access ${path}`);
      }
    },
    statfsType(path) {
      try {
        return ok(statfsSync(path).type);
      } catch (e) {
        return errFromException(e, `statfs ${path}`);
      }
    },
    osRelease: () => release(),
    arch: () => arch(),
    nodeVersion: () => process.versions.node,
    uid: () => (linux ? (process.getuid?.() ?? null) : null),
    gid: () => (linux ? (process.getgid?.() ?? null) : null),
    cwd: () => process.cwd(),
    now: () => new Date(),
    async helperProbe(): Promise<HelperOutcome> {
      const loc = locateHelper(process.env, moduleDir());
      if (!loc.ok) {
        return { path: null, source: null, result: loc };
      }
      const { path, source } = loc.value;
      const exec = checkExecutable(path);
      if (!exec.ok) {
        return { path, source, result: exec };
      }
      return { path, source, result: await runHelperProbe(path) };
    },
  };
}
