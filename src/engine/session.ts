import { z } from 'zod';
import { err, ok, type Result } from '../util/result.js';

// Sessions (prompt Stage 5 section 4.2). A session owns one workspace directory:
//   <parent>/aegis-workspace-<id>/{lower, rw/upper, rw/work, session.json}
// and survives across runs. `session.json` is written by the control plane and read back through
// this strict schema (CLAUDE.md 6.4); it replaces the shape-checked `changes.json` of Stage 3.

/** Ids the gateway and MCP generate. 128 bits, so they cannot be guessed. */
export const SERVER_ID = /^s-[0-9a-f]{32}$/;
/** Ids the one-shot CLI uses (the request id), kept for `aegis commit <id>` compatibility. */
export const CLIENT_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export const SESSION_FILE = 'session.json';

export const sessionFileSchema = z.strictObject({
  v: z.literal(1),
  id: z.string().regex(CLIENT_ID),
  owner_pid: z.number().int().positive(),
  created_ms: z.number().int().nonnegative(),
  last_used_ms: z.number().int().nonnegative(),
  source: z.string().min(1).max(4096).nullable(),
  mode: z.enum(['overlay', 'copy']).nullable(),
  state: z.enum(['idle', 'running']),
});

export type SessionFile = z.infer<typeof sessionFileSchema>;

export interface Session {
  readonly id: string;
  readonly dir: string;
  readonly lower: string;
  readonly rw: string;
  readonly upper: string;
  readonly source: string | null;
  mode: 'overlay' | 'copy' | null;
  state: 'idle' | 'running';
  readonly createdMs: number;
  lastUsedMs: number;
  runs: number;
  readonly ownerPid: number;
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export function parseSessionFile(text: string): Result<SessionFile> {
  if (text.length > 4096) return err('E2BIG', 'session file is too large');
  let raw: unknown;
  try {
    raw = JSON.parse(text, (key: string, value: unknown) => {
      if (FORBIDDEN.has(key)) throw new Error('forbidden key');
      return value;
    });
  } catch {
    return err('EINVAL', 'session file is not valid JSON');
  }
  const parsed = sessionFileSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err('EINVAL', 'session file does not match its schema');
}

export function toSessionFile(s: Session): SessionFile {
  return {
    v: 1,
    id: s.id,
    owner_pid: s.ownerPid,
    created_ms: s.createdMs,
    last_used_ms: s.lastUsedMs,
    source: s.source,
    mode: s.mode,
    state: s.state,
  };
}
