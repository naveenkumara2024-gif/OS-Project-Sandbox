/**
 * Expected failures are values, not exceptions (CLAUDE.md 5.1). Exceptions stay reserved for
 * programmer errors and truly exceptional conditions.
 */
export interface Err {
  /** errno name such as "ENOENT", or a short protocol code such as "EPROTO". */
  readonly code: string;
  /** Human-readable context. Must never contain payload data or secrets (CLAUDE.md 5.3). */
  readonly context: string;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Err };

export const okVoid: Result<void> = { ok: true, value: undefined };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err(code: string, context: string): Result<never> {
  return { ok: false, error: { code, context } };
}

/**
 * Extracts an errno-style code from a caught value. Node attaches `code` to system errors; anything
 * else is reported as EUNKNOWN so callers never see an undefined code.
 */
export function errnoCode(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const code: unknown = Reflect.get(e, 'code');
    if (typeof code === 'string' && /^E[A-Z0-9_]+$/.test(code)) {
      return code;
    }
  }
  return 'EUNKNOWN';
}

export function errFromException(e: unknown, context: string): Result<never> {
  return err(errnoCode(e), context);
}
