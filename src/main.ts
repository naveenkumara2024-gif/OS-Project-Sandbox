#!/usr/bin/env node
import { collectIsolationReport } from './probe/isolation-probe.js';
import { collectProbe, realProbeEnv } from './probe/probe.js';
import { checkExecutable, locateHelper, moduleDir } from './sys/helper.js';
import { commitMode, diffMode, discardMode, mcpMode, runMode, serveMode } from './cli/commands.js';
import { EX_SOFTWARE, EX_USAGE, loadActivePolicy, reapOrphans } from './cli/context.js';
import { errnoCode } from './util/result.js';

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
    const helper = locateHelper(process.env, moduleDir());
    const helperPath =
      helper.ok && checkExecutable(helper.value.path).ok ? helper.value.path : null;
    await reapOrphans();
    const policy = loadActivePolicy();
    const isolation = await collectIsolationReport(
      helperPath,
      policy.ok
        ? { ceiling: policy.value.ceiling, ceilingSha256: policy.value.ceilingSha256 }
        : null,
    );
    process.stdout.write(`${JSON.stringify({ ...report, isolation }, null, 2)}\n`);
    return 0;
  }

  if (mode === 'run') return runMode(argv.slice(1));
  if (mode === 'diff') return diffMode(argv.slice(1));
  if (mode === 'commit') return commitMode(argv.slice(1));
  if (mode === 'discard') return discardMode(argv.slice(1));
  if (mode === 'serve') return serveMode(argv.slice(1));

  if (mode === 'mcp') return mcpMode(argv.slice(1));

  process.stderr.write(
    'usage: aegis probe | run [--file <request.json>] | serve | mcp | diff <id> | commit <id> [--paths a,b] [--expect <sha256>] | discard <id>\n',
  );
  return EX_USAGE;
}

process.exitCode = await main(process.argv.slice(2));
