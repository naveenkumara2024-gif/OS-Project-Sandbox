import { z } from 'zod';
import { isCleanRelativePath } from '../stage/ingest.js';

// Shared by the HTTP gateway and the MCP server: the closed set of error codes, their fixed
// messages (which never echo request content), and the commit request shape.

export type ErrorCode =
  | 'invalid_request'
  | 'too_large'
  | 'not_found'
  | 'busy'
  | 'stale_diff'
  | 'policy'
  | 'isolation_unavailable'
  | 'internal'
  | 'unsupported'
  | 'shutting_down';

export const MESSAGES: Record<ErrorCode, string> = {
  invalid_request: 'the request is not valid',
  too_large: 'the request or the run is larger than allowed',
  not_found: 'no such run or session',
  busy: 'the engine or the session is busy',
  stale_diff: 'the changes differ from the ones that were approved',
  policy: 'the request is not allowed by the policy',
  isolation_unavailable: 'a required isolation layer could not be established',
  internal: 'the engine failed to handle the request',
  unsupported: 'unsupported method or content type',
  shutting_down: 'the engine is shutting down',
};

export const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  too_large: 413,
  not_found: 404,
  busy: 409,
  stale_diff: 409,
  policy: 403,
  isolation_unavailable: 422,
  internal: 500,
  unsupported: 405,
  shutting_down: 503,
};

/** Maps an engine error code to the closed set. */
export function codeFor(engineCode: string): ErrorCode {
  switch (engineCode) {
    case 'EINVAL':
    case 'ENOTDIR':
      return 'invalid_request';
    case 'ENOENT':
    case 'ESRCH':
      return 'not_found';
    case 'EBUSY':
    case 'EEXIST':
    case 'ECANCELED':
      return 'busy';
    case 'E2BIG':
      return 'too_large';
    case 'EACCES':
    case 'EPERM':
      return 'policy';
    case 'ESHUTDOWN':
      return 'shutting_down';
    default:
      return 'internal';
  }
}

export const SESSION_ID = /^s-[0-9a-f]{32}$/;

export const sessionIdSchema = z.string().regex(SESSION_ID);

export const commitBodySchema = z.strictObject({
  paths: z
    .array(z.string().max(4096).refine(isCleanRelativePath, 'must be a clean relative path'))
    .min(1)
    .max(256),
  expected_changes_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  dest: z.string().min(1).max(4096).optional(),
  close: z.boolean().optional(),
});
