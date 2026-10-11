import { z } from 'zod';
import { err, ok, type Result } from '../util/result.js';

// The request is untrusted data (CLAUDE.md 6.4): byte cap before parsing, strict schema, unknown
// fields rejected, dangerous keys rejected, bounds enforced. The model may ask for less, never more.

export const MAX_REQUEST_BYTES = 256 * 1024;
export const DEFAULT_WALL_MS = 10_000;
export const MAX_WALL_MS = 60_000;
export const DEFAULT_OUTPUT_KB = 256;
export const MAX_OUTPUT_KB = 1024;
// Resource limits (Stage 2). These bounds are constants until the Stage 4 ceiling policy exists.
export const DEFAULT_MEMORY_MB = 512;
export const MAX_MEMORY_MB = 2048;
export const DEFAULT_PIDS = 128;
export const MAX_PIDS = 512;
export const DEFAULT_CPU_PERCENT = 100;
export const MAX_CPU_PERCENT = 400;
export const DEFAULT_CPU_MS = 10_000;
export const MAX_CPU_MS = 300_000;
export const DEFAULT_DISK_MB = 16;
export const MAX_DISK_MB = 256;
const MAX_ENV_ENTRIES = 32;
const MAX_ENV_BYTES = 8 * 1024;
const MAX_ARG_BYTES = 4095; // the launch spec stores a NUL after each string within 4096 bytes

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_FILES = 256;
const MAX_FILE_BYTES = 1024 * 1024;
const noNulPath = (s: string): boolean => !s.includes('\0') && !s.startsWith('/') && s !== '';
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

const noNul = (s: string): boolean => !s.includes('\0');
const withinBytes = (s: string): boolean => Buffer.byteLength(s, 'utf8') <= MAX_ARG_BYTES;

const fileSchema = z.strictObject({
  path: z.string().max(4096).refine(noNulPath, 'must be a clean relative path'),
  content: z.string().max(MAX_FILE_BYTES),
});

const workspaceSchema = z.strictObject({
  source: z.string().min(1).max(4096).refine(noNul),
  mode: z.enum(['overlay']).optional(),
});

const requestSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  files: z.array(fileSchema).max(MAX_FILES).default([]),
  workspace: workspaceSchema.optional(),
  command: z
    .array(z.string().refine(noNul).refine(withinBytes))
    .min(1)
    .max(64)
    .refine((c) => (c[0] ?? '').startsWith('/'), 'command[0] must be an absolute path'),
  env: z.record(z.string(), z.string().refine(noNul).refine(withinBytes)).default({}),
  limits: z
    .strictObject({
      wall_ms: z.number().int().min(1).max(MAX_WALL_MS).default(DEFAULT_WALL_MS),
      output_kb: z.number().int().min(1).max(MAX_OUTPUT_KB).default(DEFAULT_OUTPUT_KB),
      memory_mb: z.number().int().min(1).max(MAX_MEMORY_MB).default(DEFAULT_MEMORY_MB),
      pids: z.number().int().min(1).max(MAX_PIDS).default(DEFAULT_PIDS),
      cpu_percent: z.number().int().min(1).max(MAX_CPU_PERCENT).default(DEFAULT_CPU_PERCENT),
      cpu_ms: z.number().int().min(1).max(MAX_CPU_MS).default(DEFAULT_CPU_MS),
      disk_mb: z.number().int().min(1).max(MAX_DISK_MB).default(DEFAULT_DISK_MB),
    })
    .default({
      wall_ms: DEFAULT_WALL_MS,
      output_kb: DEFAULT_OUTPUT_KB,
      memory_mb: DEFAULT_MEMORY_MB,
      pids: DEFAULT_PIDS,
      cpu_percent: DEFAULT_CPU_PERCENT,
      cpu_ms: DEFAULT_CPU_MS,
      disk_mb: DEFAULT_DISK_MB,
    }),
});

export interface RunRequest {
  readonly id: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly workspaceSource: string | null;
  readonly command: readonly string[];
  /** A Map, never a plain object: caller-supplied keys must not touch prototypes (CLAUDE.md 6.4). */
  readonly env: ReadonlyMap<string, string>;
  readonly wallMs: number;
  readonly outputBytes: number;
  readonly memoryMb: number;
  readonly pids: number;
  readonly cpuPercent: number;
  readonly cpuMs: number;
  readonly diskMb: number;
}

function invalid(context: string): Result<never> {
  return err('EINVAL', context);
}

/**
 * Parses and validates a request. Error contexts name the offending field path and the rule, never
 * the received value (CLAUDE.md 5.3: payload contents are not logged).
 */
export function parseRunRequest(input: Buffer | string): Result<RunRequest> {
  const size = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.length;
  if (size > MAX_REQUEST_BYTES) {
    return err('E2BIG', 'request exceeds the byte limit');
  }
  const text = typeof input === 'string' ? input : input.toString('utf8');

  let raw: unknown;
  try {
    raw = JSON.parse(text, (key: string, value: unknown) => {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new Error('forbidden key');
      }
      return value;
    });
  } catch {
    return invalid('request is not valid JSON, or contains a forbidden key');
  }

  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.code}`)
      .join('; ');
    return invalid(`request schema violation at ${where}`);
  }
  const data = parsed.data;

  const env = new Map<string, string>();
  let envBytes = 0;
  for (const [name, value] of Object.entries(data.env)) {
    if (!ENV_NAME.test(name) || name === 'PATH' || name.startsWith('LD_')) {
      return invalid('env contains a name that is not allowed');
    }
    envBytes += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8') + 2;
    env.set(name, value);
  }
  if (env.size > MAX_ENV_ENTRIES || envBytes > MAX_ENV_BYTES) {
    return invalid('env exceeds its size limits');
  }

  return ok({
    id: data.id,
    files: data.files,
    workspaceSource: data.workspace?.source ?? null,
    command: data.command,
    env,
    wallMs: data.limits.wall_ms,
    outputBytes: data.limits.output_kb * 1024,
    memoryMb: data.limits.memory_mb,
    pids: data.limits.pids,
    cpuPercent: data.limits.cpu_percent,
    cpuMs: data.limits.cpu_ms,
    diskMb: data.limits.disk_mb,
  });
}
