// Structured logging (CLAUDE.md 5.3): one JSON object per line, built only from typed events with
// allow-listed fields. The logger cannot be handed an arbitrary value: whatever an event object
// carries beyond the allow-list is dropped, and every value is a short, control-free primitive,
// so payload contents, environment variables and file contents cannot reach a log line.

export type LogEvent =
  | {
      readonly event:
        | 'run_queued'
        | 'run_started'
        | 'run_finished'
        | 'run_cancelled'
        | 'run_refused'
        | 'run_failed';
      readonly run: string;
      readonly session?: string | null;
      readonly manifest_sha256?: string;
      readonly cause?: string;
      readonly level?: number;
      readonly wall_ms?: number;
      readonly code?: string;
    }
  | {
      readonly event:
        | 'session_created'
        | 'session_expired'
        | 'session_discarded'
        | 'session_committed'
        | 'session_swept';
      readonly session: string;
      readonly paths?: number;
      readonly committed?: number;
      readonly refused?: number;
    }
  | {
      readonly event: 'broker_decision';
      readonly run: string;
      readonly manifest_sha256?: string;
      readonly host: string;
      readonly port: number;
      readonly decision: 'allow' | 'deny';
      readonly reason: string;
    }
  | { readonly event: 'gateway_rejected'; readonly reason: string; readonly status: number }
  | {
      readonly event: 'engine_started' | 'engine_stopped' | 'gateway_listening' | 'mcp_started';
      readonly detail?: string;
    };

const ALLOWED = new Set([
  'event',
  'run',
  'session',
  'manifest_sha256',
  'cause',
  'level',
  'wall_ms',
  'code',
  'paths',
  'committed',
  'refused',
  'host',
  'port',
  'decision',
  'reason',
  'status',
  'detail',
]);
const MAX_STRING = 200;
const CONTROL = /[\u0000-\u001f\u007f]/g;

export function formatLogEvent(e: LogEvent, now: () => number = Date.now): string {
  const out: Record<string, string | number | boolean | null> = { ts: now() };
  for (const [key, value] of Object.entries(e)) {
    if (!ALLOWED.has(key)) continue;
    if (typeof value === 'string') out[key] = value.replace(CONTROL, '?').slice(0, MAX_STRING);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean' || value === null) out[key] = value;
  }
  return JSON.stringify(out);
}

export interface Logger {
  log(e: LogEvent): void;
}

export const nullLogger: Logger = {
  log(): void {
    // intentionally nothing
  },
};

export function lineLogger(write: (line: string) => void, now: () => number = Date.now): Logger {
  return {
    log(e: LogEvent): void {
      write(`${formatLogEvent(e, now)}\n`);
    },
  };
}
