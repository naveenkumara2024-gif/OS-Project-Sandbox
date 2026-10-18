import { err, ok, type Result } from '../util/result.js';

// Launch-spec wire format shared with native/src/spec.h. The helper contains no JSON parser
// (CLAUDE.md 4): validation, clamping and hashing happen here and only this flat format crosses.
//
//   header  : "AEGS", u16 version, u16 reserved (0), u32 total_len (header included)
//   records : u16 key, u16 reserved (0), u32 len, len bytes
//
// All integers are little-endian. Strings carry their own terminating NUL inside the record.

export const SPEC_VERSION = 1;
export const SPEC_HEADER_BYTES = 12;
export const SPEC_MAX_BYTES = 65536;
/** Includes the terminating NUL, matching AEGIS_SPEC_MAX_STRING. */
export const SPEC_MAX_STRING = 4096;
export const SPEC_MAX_ARGV = 64;
export const SPEC_MAX_ENV = 64;
export const SPEC_MAX_ENTRIES = 512;
export const SPEC_MAX_MASKS = 32;
export const SPEC_MIN_TMPFS_BYTES = 1 << 20;
export const SPEC_MAX_TMPFS_BYTES = 1 << 30;

const KEY = {
  argv: 1,
  env: 2,
  rootMountpoint: 3,
  hostname: 4,
  rootTmpfsBytes: 5,
  tmpTmpfsBytes: 6,
  rootEntry: 7,
  maskFile: 8,
  maskDir: 9,
  cgroupFd: 10,
  workspaceLower: 11,
  workspaceRw: 12,
  workspaceForceCopy: 13,
  requireMask: 14,
  ablateMask: 15,
  brokerSocket: 16,
} as const;

/** Bits of REQUIRE_MASK: the layers the helper itself refuses to start without (native/src/spec.h,
 * enum aegis_require_bit). Every other required layer is checked from the receipt in TypeScript. */
export const REQUIRE_BITS = {
  caps_dropped: 1 << 0,
  no_new_privs: 1 << 1,
  seccomp: 1 << 2,
  landlock: 1 << 3,
  overlay: 1 << 4,
} as const;
export const REQUIRE_MASK_ALL = 0x1f;

/** The descriptor number the helper expects the cgroup directory on (native/src/spec.h). */
export const CGROUP_FD = 6;

const KIND = { 'bind-dir': 1, 'bind-file': 2, symlink: 3, mkdir: 4 } as const;
const KIND_BY_CODE = new Map<number, RootEntryKind>([
  [1, 'bind-dir'],
  [2, 'bind-file'],
  [3, 'symlink'],
  [4, 'mkdir'],
]);

export type RootEntryKind = keyof typeof KIND;

export interface RootEntry {
  readonly kind: RootEntryKind;
  /** Bind source, or the link text of a symlink. Empty for `mkdir`. */
  readonly src: string;
  /** Absolute path inside the new root. */
  readonly tgt: string;
}

export interface LaunchSpec {
  readonly argv: readonly string[];
  /** `NAME=value` strings, the payload's whole environment. */
  readonly env: readonly string[];
  readonly rootMountpoint: string;
  readonly hostname: string;
  readonly rootTmpfsBytes: number;
  readonly tmpTmpfsBytes: number;
  readonly entries: readonly RootEntry[];
  readonly maskFiles: readonly string[];
  readonly maskDirs: readonly string[];
  /** True when the control plane passes a cgroup directory on descriptor 6 (CLONE_INTO_CGROUP). */
  readonly cgroupFd: boolean;
  /** Layers the helper must establish before the payload runs (REQUIRE_BITS). Left out, the helper
   * assumes caps_dropped, no_new_privs and seccomp; it never assumes "nothing". */
  readonly requireMask?: number;
  /** Test only: hardening layers (REQUIRE_BITS, never overlay) the helper must treat as
   * unavailable without trying them. Only builds compiled with AEGIS_ENABLE_ABLATION accept it;
   * `release` rejects the spec. */
  readonly ablateMask?: number;
  /** Host path of the egress broker's Unix socket; present only for a brokered cell. */
  readonly brokerSocket?: string;
  /** Host paths for the workspace binds (Stage 3); all three present together, or omitted. */
  readonly workspace?: {
    readonly lower: string;
    /** Host directory already containing "upper" and "work" subdirectories (same mount, as
     * overlayfs requires of upperdir/workdir). */
    readonly rw: string;
    /** Skip the overlay attempt and go straight to the copy fallback (tests only). */
    readonly forceCopy: boolean;
  };
}

function badSpec(context: string): Result<never> {
  return err('EINVAL', `launch spec: ${context}`);
}

/** Absolute, not the bare root, no empty, "." or ".." component (mirrors check_abs_path in C). */
export function isCleanAbsolutePath(path: string): boolean {
  if (!path.startsWith('/') || path === '/') {
    return false;
  }
  const parts = path.slice(1).split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..');
}

/** The cell's tree is the host's /usr and nothing else (Amendment 1 of the Stage 1 prompt). */
export function isUnderUsr(path: string): boolean {
  return path === '/usr' || path.startsWith('/usr/');
}

function stringBytes(s: string): Buffer | null {
  if (s.includes('\0')) {
    return null;
  }
  const raw = Buffer.from(s, 'utf8');
  if (raw.length + 1 > SPEC_MAX_STRING) {
    return null;
  }
  return Buffer.concat([raw, Buffer.alloc(1)]);
}

class Writer {
  readonly #parts: Buffer[] = [];
  #size = SPEC_HEADER_BYTES;

  get size(): number {
    return this.#size;
  }

  record(key: number, body: Buffer): void {
    const head = Buffer.alloc(8);
    head.writeUInt16LE(key, 0);
    head.writeUInt16LE(0, 2);
    head.writeUInt32LE(body.length, 4);
    this.#parts.push(head, body);
    this.#size += 8 + body.length;
  }

  finish(): Buffer {
    const header = Buffer.alloc(SPEC_HEADER_BYTES);
    header.write('AEGS', 0, 'latin1');
    header.writeUInt16LE(SPEC_VERSION, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt32LE(this.#size, 8);
    return Buffer.concat([header, ...this.#parts], this.#size);
  }
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

/** Validates against the same bounds the native parser enforces, then encodes. */
export function encodeLaunchSpec(spec: LaunchSpec): Result<Uint8Array> {
  if (spec.argv.length < 1 || spec.argv.length > SPEC_MAX_ARGV) {
    return badSpec('argv count out of range');
  }
  if (spec.env.length > SPEC_MAX_ENV) {
    return badSpec('env count out of range');
  }
  if (spec.entries.length > SPEC_MAX_ENTRIES) {
    return err('E2BIG', 'launch spec: too many root entries');
  }
  if (spec.maskFiles.length > SPEC_MAX_MASKS || spec.maskDirs.length > SPEC_MAX_MASKS) {
    return badSpec('too many masks');
  }
  for (const n of [spec.rootTmpfsBytes, spec.tmpTmpfsBytes]) {
    if (!Number.isSafeInteger(n) || n < SPEC_MIN_TMPFS_BYTES || n > SPEC_MAX_TMPFS_BYTES) {
      return badSpec('tmpfs size out of range');
    }
  }
  if (!isCleanAbsolutePath(spec.rootMountpoint)) {
    return badSpec('root mountpoint is not a clean absolute path');
  }
  const first = spec.argv[0];
  if (first === undefined || !first.startsWith('/')) {
    return badSpec('argv[0] must be absolute');
  }
  if (spec.hostname === '' || spec.hostname.length > 64 || spec.hostname.includes('/')) {
    return badSpec('bad hostname');
  }

  const w = new Writer();
  const str = (key: number, value: string, what: string): Result<void> => {
    const b = stringBytes(value);
    if (b === null) {
      return badSpec(`${what} is too long or contains NUL`);
    }
    w.record(key, b);
    return ok(undefined);
  };

  for (const a of spec.argv) {
    const r = str(KEY.argv, a, 'argv element');
    if (!r.ok) return r;
  }
  for (const e of spec.env) {
    const eq = e.indexOf('=');
    if (eq < 1) {
      return badSpec('env entry must be NAME=value');
    }
    const r = str(KEY.env, e, 'env entry');
    if (!r.ok) return r;
  }
  let r = str(KEY.rootMountpoint, spec.rootMountpoint, 'root mountpoint');
  if (!r.ok) return r;
  r = str(KEY.hostname, spec.hostname, 'hostname');
  if (!r.ok) return r;
  w.record(KEY.rootTmpfsBytes, u64(spec.rootTmpfsBytes));
  w.record(KEY.tmpTmpfsBytes, u64(spec.tmpTmpfsBytes));

  for (const e of spec.entries) {
    const src = stringBytes(e.src);
    const tgt = stringBytes(e.tgt);
    if (src === null || tgt === null) {
      return badSpec('root entry string is too long or contains NUL');
    }
    if (!isCleanAbsolutePath(e.tgt) || !isUnderUsr(e.tgt)) {
      return badSpec('root entry target is not a clean absolute path under /usr');
    }
    if (e.kind === 'bind-dir' || e.kind === 'bind-file') {
      if (!isCleanAbsolutePath(e.src) || !isUnderUsr(e.src)) {
        return badSpec('root entry source is not a clean absolute path under /usr');
      }
    } else if (e.kind === 'mkdir') {
      if (e.src !== '') {
        return badSpec('mkdir entry must have an empty source');
      }
    } else if (e.src === '') {
      return badSpec('symlink entry needs link text');
    }
    const head = Buffer.alloc(5);
    head.writeUInt8(KIND[e.kind], 0);
    head.writeUInt16LE(src.length, 1);
    head.writeUInt16LE(tgt.length, 3);
    w.record(KEY.rootEntry, Buffer.concat([head, src, tgt]));
  }
  for (const m of spec.maskFiles) {
    if (!isCleanAbsolutePath(m) || !isUnderUsr(m)) return badSpec('mask path is not under /usr');
    const r2 = str(KEY.maskFile, m, 'mask path');
    if (!r2.ok) return r2;
  }
  if (spec.cgroupFd) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(CGROUP_FD, 0);
    w.record(KEY.cgroupFd, b);
  }
  if (spec.requireMask !== undefined) {
    if (
      !Number.isInteger(spec.requireMask) ||
      spec.requireMask < 0 ||
      spec.requireMask > REQUIRE_MASK_ALL
    ) {
      return badSpec('require mask out of range');
    }
    const b = Buffer.alloc(4);
    b.writeUInt32LE(spec.requireMask, 0);
    w.record(KEY.requireMask, b);
  }
  if (spec.brokerSocket !== undefined) {
    if (!isCleanAbsolutePath(spec.brokerSocket)) {
      return badSpec('broker socket path is not a clean absolute path');
    }
    const rb = str(KEY.brokerSocket, spec.brokerSocket, 'broker socket path');
    if (!rb.ok) return rb;
  }
  if (spec.ablateMask !== undefined) {
    if (
      !Number.isInteger(spec.ablateMask) ||
      spec.ablateMask < 1 ||
      spec.ablateMask > REQUIRE_MASK_ALL ||
      (spec.ablateMask & REQUIRE_BITS.overlay) !== 0
    ) {
      return badSpec('ablate mask out of range');
    }
    const b = Buffer.alloc(4);
    b.writeUInt32LE(spec.ablateMask, 0);
    w.record(KEY.ablateMask, b);
  }
  if (spec.workspace !== undefined) {
    const ws = spec.workspace;
    for (const [key, value] of [
      [KEY.workspaceLower, ws.lower],
      [KEY.workspaceRw, ws.rw],
    ] as const) {
      if (!isCleanAbsolutePath(value)) {
        return badSpec('workspace path is not a clean absolute path');
      }
      const r2 = str(key, value, 'workspace path');
      if (!r2.ok) return r2;
    }
    if (ws.forceCopy) {
      w.record(KEY.workspaceForceCopy, Buffer.alloc(0));
    }
  }
  for (const m of spec.maskDirs) {
    if (!isCleanAbsolutePath(m) || !isUnderUsr(m)) return badSpec('mask path is not under /usr');
    const r2 = str(KEY.maskDir, m, 'mask path');
    if (!r2.ok) return r2;
  }

  if (w.size > SPEC_MAX_BYTES) {
    return err('E2BIG', 'launch spec: over the size cap');
  }
  return ok(new Uint8Array(w.finish()));
}

/**
 * Reference decoder, used by tests to prove the encoder round-trips. It is deliberately a separate
 * implementation from the native parser; the production decoder is native/src/spec.c.
 */
export function decodeLaunchSpec(bytes: Uint8Array): Result<LaunchSpec> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < SPEC_HEADER_BYTES || buf.length > SPEC_MAX_BYTES) {
    return badSpec('bad length');
  }
  if (buf.toString('latin1', 0, 4) !== 'AEGS') {
    return badSpec('bad magic');
  }
  if (buf.readUInt16LE(4) !== SPEC_VERSION || buf.readUInt16LE(6) !== 0) {
    return badSpec('bad version');
  }
  if (buf.readUInt32LE(8) !== buf.length) {
    return badSpec('length mismatch');
  }

  const argv: string[] = [];
  const env: string[] = [];
  const entries: RootEntry[] = [];
  const maskFiles: string[] = [];
  const maskDirs: string[] = [];
  let rootMountpoint: string | null = null;
  let hostname: string | null = null;
  let rootTmpfsBytes: number | null = null;
  let tmpTmpfsBytes: number | null = null;
  let cgroupFd = false;
  let wLower: string | null = null;
  let wRw: string | null = null;
  let wForceCopy = false;
  let requireMask: number | null = null;
  let ablateMask: number | null = null;
  let brokerSocket: string | null = null;

  const text = (b: Buffer): string | null => {
    if (b.length < 1 || b[b.length - 1] !== 0 || b.subarray(0, b.length - 1).includes(0)) {
      return null;
    }
    return b.toString('utf8', 0, b.length - 1);
  };

  let off = SPEC_HEADER_BYTES;
  while (off < buf.length) {
    if (buf.length - off < 8) return badSpec('short record');
    const key = buf.readUInt16LE(off);
    const len = buf.readUInt32LE(off + 4);
    off += 8;
    if (len > buf.length - off) return badSpec('record overruns the buffer');
    const body = buf.subarray(off, off + len);
    off += len;
    const s = text(body);
    switch (key) {
      case KEY.argv:
        if (s === null) return badSpec('bad argv string');
        argv.push(s);
        break;
      case KEY.env:
        if (s === null) return badSpec('bad env string');
        env.push(s);
        break;
      case KEY.rootMountpoint:
        if (s === null || rootMountpoint !== null) return badSpec('bad root mountpoint');
        rootMountpoint = s;
        break;
      case KEY.hostname:
        if (s === null || hostname !== null) return badSpec('bad hostname');
        hostname = s;
        break;
      case KEY.rootTmpfsBytes:
      case KEY.tmpTmpfsBytes: {
        if (body.length !== 8) return badSpec('bad size record');
        const v = Number(body.readBigUInt64LE(0));
        if (key === KEY.rootTmpfsBytes) rootTmpfsBytes = v;
        else tmpTmpfsBytes = v;
        break;
      }
      case KEY.rootEntry: {
        if (body.length < 5) return badSpec('short entry');
        const kind = KIND_BY_CODE.get(body.readUInt8(0));
        const sl = body.readUInt16LE(1);
        const tl = body.readUInt16LE(3);
        if (kind === undefined || body.length !== 5 + sl + tl) return badSpec('bad entry');
        const src = text(body.subarray(5, 5 + sl));
        const tgt = text(body.subarray(5 + sl));
        if (src === null || tgt === null) return badSpec('bad entry string');
        entries.push({ kind, src, tgt });
        break;
      }
      case KEY.maskFile:
        if (s === null) return badSpec('bad mask');
        maskFiles.push(s);
        break;
      case KEY.maskDir:
        if (s === null) return badSpec('bad mask');
        maskDirs.push(s);
        break;
      case KEY.cgroupFd:
        if (body.length !== 4 || body.readUInt32LE(0) !== CGROUP_FD || cgroupFd) {
          return badSpec('bad cgroup fd record');
        }
        cgroupFd = true;
        break;
      case KEY.workspaceLower:
      case KEY.workspaceRw: {
        if (s === null) return badSpec('bad workspace path');
        if (key === KEY.workspaceLower) {
          if (wLower !== null) return badSpec('duplicate workspace path');
          wLower = s;
        } else {
          if (wRw !== null) return badSpec('duplicate workspace path');
          wRw = s;
        }
        break;
      }
      case KEY.workspaceForceCopy:
        if (body.length !== 0 || wForceCopy) return badSpec('bad workspace force-copy record');
        wForceCopy = true;
        break;
      case KEY.requireMask:
        if (body.length !== 4 || requireMask !== null) return badSpec('bad require-mask record');
        requireMask = body.readUInt32LE(0);
        if (requireMask > REQUIRE_MASK_ALL) return badSpec('require mask out of range');
        break;
      case KEY.brokerSocket:
        if (s === null || brokerSocket !== null) return badSpec('bad broker socket record');
        brokerSocket = s;
        break;
      case KEY.ablateMask:
        if (body.length !== 4 || ablateMask !== null) return badSpec('bad ablate-mask record');
        ablateMask = body.readUInt32LE(0);
        break;
      default:
        return badSpec('unknown key');
    }
  }
  if (
    argv.length === 0 ||
    rootMountpoint === null ||
    hostname === null ||
    rootTmpfsBytes === null ||
    tmpTmpfsBytes === null
  ) {
    return badSpec('required key missing');
  }
  return ok({
    argv,
    env,
    rootMountpoint,
    hostname,
    rootTmpfsBytes,
    tmpTmpfsBytes,
    entries,
    maskFiles,
    maskDirs,
    cgroupFd,
    ...(requireMask !== null ? { requireMask } : {}),
    ...(ablateMask !== null ? { ablateMask } : {}),
    ...(brokerSocket !== null ? { brokerSocket } : {}),
    ...(wLower !== null && wRw !== null
      ? { workspace: { lower: wLower, rw: wRw, forceCopy: wForceCopy } }
      : {}),
  });
}
