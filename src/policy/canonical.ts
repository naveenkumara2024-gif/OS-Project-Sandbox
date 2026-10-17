import { err, ok, type Result } from '../util/result.js';

// Canonical JSON for hashing (prompt Stage 4 section 4.6): object keys sorted by UTF-16 code unit,
// no whitespace, integers only, arrays kept in the order given (the caller sorts sets first).
// Floats are refused instead of formatted, because two implementations disagree on how to print
// them and a hash must not depend on that.

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export function canonicalJson(value: CanonicalValue): Result<string> {
  if (value === null) return ok('null');
  switch (typeof value) {
    case 'string':
      return ok(JSON.stringify(value));
    case 'boolean':
      return ok(value ? 'true' : 'false');
    case 'number':
      if (!Number.isSafeInteger(value)) {
        return err('EINVAL', 'canonical JSON: only safe integers are allowed');
      }
      return ok(String(value));
    default:
      break;
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value as readonly CanonicalValue[]) {
      const r = canonicalJson(item);
      if (!r.ok) return r;
      parts.push(r.value);
    }
    return ok(`[${parts.join(',')}]`);
  }
  const obj = value as { readonly [key: string]: CanonicalValue };
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) {
      return err('EINVAL', 'canonical JSON: undefined value');
    }
    const r = canonicalJson(v);
    if (!r.ok) return r;
    parts.push(`${JSON.stringify(key)}:${r.value}`);
  }
  return ok(`{${parts.join(',')}}`);
}
