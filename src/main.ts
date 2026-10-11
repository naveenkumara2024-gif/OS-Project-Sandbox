#!/usr/bin/env node
import { collectProbe, realProbeEnv } from './probe/probe.js';
import { errnoCode } from './util/result.js';

// sysexits.h values, spelled out so each exit status is documented where it is used.
const EX_USAGE = 64;
const EX_SOFTWARE = 70;

const NOT_IMPLEMENTED = new Set(['run', 'serve', 'mcp']);

function logFatal(event: string, reason: unknown): void {
  // Only the event name and an error code are logged: never the message, which could carry
  // payload or path data (CLAUDE.md 5.3).
  process.stderr.write(`${JSON.stringify({ level: 'fatal', event, code: errnoCode(reason) })}\n`);
}

process.on('unhandledRejection', (reason: unknown) => {
  logFatal('unhandled_rejection', reason);
  process.exit(EX_SOFTWARE);
});
process.on('uncaughtException', (error: unknown) => {
  logFatal('uncaught_exception', error);
  process.exit(EX_SOFTWARE);
});

async function main(argv: readonly string[]): Promise<number> {
  const mode = argv[0];

  if (mode === 'probe') {
    const report = await collectProbe(realProbeEnv());
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  if (mode !== undefined && NOT_IMPLEMENTED.has(mode)) {
    process.stderr.write(`aegis ${mode}: not implemented in stage 0\n`);
    return EX_USAGE;
  }

  process.stderr.write('usage: aegis probe\n');
  return EX_USAGE;
}

process.exitCode = await main(process.argv.slice(2));
