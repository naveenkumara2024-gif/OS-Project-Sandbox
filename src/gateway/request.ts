import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { SERVER_ID } from '../engine/session.js';
import {
  manifestRequestSchema,
  requestedLimitsSchema,
  toManifestRequest,
  type ManifestRequest,
} from '../policy/manifest.js';
import { err, ok, type Result } from '../util/result.js';

// The request is untrusted data (CLAUDE.md 6.4): byte cap before parsing, strict schema, unknown
// fields rejected, dangerous keys rejected. The model may ask for less, never more: values are
// bounded here only for sanity and then clamped to the ceiling policy (src/policy/manifest.ts).

export const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_ENV_ENTRIES = 32;
const MAX_ENV_BYTES = 8 * 1024;
const MAX_ARG_BYTES = 4095; // the launch spec stores a NUL after each string within 4096 bytes

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_FILES = 256;
const MAX_FILE_BYTES = 1024 * 1024;
const noNulPath = (s: string): boolean => !s.includes('\0') && !s.startsWith('/') && s !== '';
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
// Names the engine sets itself (PATH, and the proxy variables of a brokered cell); a request
// cannot override them.
const RESERVED_ENV = new Set([
  'PATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'FTP_PROXY',
]);

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

export const requestSchema = z.strictObject({
  // A label for the caller's own bookkeeping. Optional: the engine's own run and session ids are
  // the authoritative ones.
  id: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,64}$/)
    .optional(),
  // Continue this session (Stage 5). Only ids the engine generated are accepted.
  session: z.string().regex(SERVER_ID).optional(),
  files: z.array(fileSchema).max(MAX_FILES).default([]),
  workspace: workspaceSchema.optional(),
  command: z
    .array(z.string().refine(noNul).refine(withinBytes))
    .min(1)
    .max(64)
    .refine((c) => (c[0] ?? '').startsWith('/'), 'command[0] must be an absolute path'),
  env: z.record(z.string(), z.string().refine(noNul).refine(withinBytes)).default({}),
  // Legacy spelling of manifest.limits, kept so existing callers work. Giving both is an error.
  limits: requestedLimitsSchema.optional(),
  manifest: manifestRequestSchema.optional(),
});

export interface RunRequest {
  /** The caller's label, or one generated here. */
  readonly id: string;
  /** The session to continue, or null to start a new one (when there are files or a source). */
  readonly session: string | null;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly workspaceSource: string | null;
  readonly command: readonly string[];
  /** A Map, never a plain object: caller-supplied keys must not touch prototypes (CLAUDE.md 6.4). */
  readonly env: ReadonlyMap<string, string>;
  /** What the request asked for. Not yet clamped: resolveManifest applies the ceiling. */
  readonly manifest: ManifestRequest;
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
    if (!ENV_NAME.test(name) || RESERVED_ENV.has(name) || name.startsWith('LD_')) {
      return invalid('env contains a name that is not allowed');
    }
    envBytes += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8') + 2;
    env.set(name, value);
  }
  if (env.size > MAX_ENV_ENTRIES || envBytes > MAX_ENV_BYTES) {
    return invalid('env exceeds its size limits');
  }

  if (data.limits !== undefined && data.manifest !== undefined) {
    return invalid('request has both limits and manifest; use only manifest');
  }
  const manifest = toManifestRequest(
    data.manifest ?? (data.limits !== undefined ? { limits: data.limits } : {}),
  );

  return ok({
    id: data.id ?? `q-${randomBytes(8).toString('hex')}`,
    session: data.session ?? null,
    files: data.files,
    workspaceSource: data.workspace?.source ?? null,
    command: data.command,
    env,
    manifest,
  });
}
