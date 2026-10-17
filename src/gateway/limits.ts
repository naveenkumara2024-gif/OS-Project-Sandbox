import { MAX_REQUEST_BYTES } from './request.js';

// Hard limits for the gateway (prompt Stage 5 section 4.4). Every one is a cap on something a
// client controls; none is configurable by a request.

export interface GatewayLimits {
  readonly maxBodyBytes: number;
  readonly maxHeaderBytes: number;
  readonly maxHeaders: number;
  readonly maxConnections: number;
  readonly headersTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly keepAliveTimeoutMs: number;
}

export const DEFAULT_LIMITS: GatewayLimits = {
  maxBodyBytes: MAX_REQUEST_BYTES,
  maxHeaderBytes: 16 * 1024,
  maxHeaders: 32,
  maxConnections: 32,
  headersTimeoutMs: 5_000,
  requestTimeoutMs: 30_000,
  keepAliveTimeoutMs: 5_000,
};
