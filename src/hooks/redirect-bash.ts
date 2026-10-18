import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// A Claude Code `PreToolUse` hook for the Bash tool (blueprint "A PreToolUse hook to redirect raw
// shell use"). It reads the tool call as JSON on stdin; when the command would run program code
// directly on the host it exits with code 2 and a message, which blocks the call and is shown to
// the model: "run it with mcp__aegis__run instead".
//
// This is a guide rail that makes the safe path the easy one. It is NOT a security boundary: it
// is heuristic text matching on a shell command, and an agent that holds an unrestricted shell can
// always get around it. The boundary is the cell. It fails open (any input it cannot read is
// allowed), because a hook that breaks every shell command would just be switched off.

export const MESSAGE =
  'This command runs program code directly on the host. Run untrusted or generated code with the ' +
  'mcp__aegis__run tool instead: it executes the command in an isolated cell and returns the ' +
  'result, and the real project only changes after you review mcp__aegis__diff and a person ' +
  'approves mcp__aegis__commit. If you really need the host shell for this, ask the user.';

/** Programs that execute code they are given (a script, a project, or an inline program). */
const RUNNERS = new Set([
  'python',
  'python2',
  'python3',
  'pypy',
  'pypy3',
  'node',
  'nodejs',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
  'lua',
  'luajit',
  'julia',
  'Rscript',
  'java',
  'dotnet',
  'tsx',
  'ts-node',
  'npx',
  'pnpx',
  'bunx',
  'uv',
  'uvx',
  'pytest',
  'jest',
  'vitest',
  'make',
  'cmake',
  'cargo',
  'go',
  'gradle',
  'mvn',
]);
/** Package managers: only the subcommands that execute project code. */
const PKG = new Map<string, Set<string>>([
  [
    'npm',
    new Set(['run', 'start', 'test', 'exec', 'x', 'run-script', 'rebuild', 'install', 'i', 'ci']),
  ],
  ['pnpm', new Set(['run', 'start', 'test', 'exec', 'dlx', 'install', 'i'])],
  ['yarn', new Set(['run', 'start', 'test', 'dlx', 'install'])],
  ['pip', new Set(['install'])],
  ['pip3', new Set(['install'])],
]);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const WRAPPERS = new Set([
  'sudo',
  'time',
  'nohup',
  'env',
  'command',
  'exec',
  'nice',
  'stdbuf',
  'timeout',
]);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Splits on the shell's command separators. Naive about quoting, which is fine for a guide rail. */
function simpleCommands(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((part) =>
      part
        .trim()
        .split(/\s+/)
        .filter((w) => w !== ''),
    )
    .filter((words) => words.length > 0);
}

function basename(word: string): string {
  const unquoted = word.replace(/^['"]|['"]$/g, '');
  return unquoted.slice(unquoted.lastIndexOf('/') + 1);
}

export function decide(command: string): { readonly block: boolean; readonly reason?: string } {
  // `curl ... | sh` style: fetching and running in one go.
  if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(command)) {
    return { block: true, reason: 'pipes a download into a shell' };
  }
  for (const words of simpleCommands(command)) {
    let i = 0;
    for (;;) {
      const w = words[i];
      if (w === undefined) break;
      if (ENV_ASSIGN.test(w)) {
        i++;
        continue;
      }
      if (WRAPPERS.has(basename(w))) {
        i++;
        // `timeout 5 cmd` and `nice -n 5 cmd` carry an argument before the command.
        while (
          words[i] !== undefined &&
          (words[i]?.startsWith('-') === true || /^\d+$/.test(words[i] ?? ''))
        )
          i++;
        continue;
      }
      break;
    }
    const first = words[i];
    if (first === undefined) continue;
    const name = basename(first);
    const rest = words.slice(i + 1);
    if (RUNNERS.has(name)) return { block: true, reason: `runs ${name}` };
    const sub = PKG.get(name);
    if (sub !== undefined) {
      const verb = rest.find((r) => !r.startsWith('-'));
      if (verb !== undefined && sub.has(verb))
        return { block: true, reason: `runs ${name} ${verb}` };
    }
    if (SHELLS.has(name)) {
      const target = rest.find((r) => !r.startsWith('-'));
      if (target !== undefined && !rest.includes('-c')) {
        return { block: true, reason: `runs a script with ${name}` };
      }
    }
    // A local executable: ./run.sh, ../tool, build/app
    if (first.startsWith('./') || first.startsWith('../')) {
      return { block: true, reason: 'runs a local executable' };
    }
  }
  return { block: false };
}

interface HookInput {
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
}

const MAX_INPUT_BYTES = 1024 * 1024;

/** Runs the hook against a stdin text. Returns the exit code and what to write to stderr. */
export function evaluate(stdin: string, env: NodeJS.ProcessEnv): { code: 0 | 2; stderr: string } {
  if (env['AEGIS_HOOK_DISABLE'] === '1') return { code: 0, stderr: '' };
  let input: HookInput;
  try {
    const parsed: unknown = JSON.parse(stdin);
    if (typeof parsed !== 'object' || parsed === null) return { code: 0, stderr: '' };
    input = {
      tool_name: Reflect.get(parsed, 'tool_name'),
      tool_input: Reflect.get(parsed, 'tool_input'),
    };
  } catch {
    return { code: 0, stderr: 'aegis hook: input was not JSON; allowing the call\n' };
  }
  if (input.tool_name !== 'Bash') return { code: 0, stderr: '' };
  const ti = input.tool_input;
  const command: unknown =
    typeof ti === 'object' && ti !== null ? Reflect.get(ti, 'command') : undefined;
  if (typeof command !== 'string') return { code: 0, stderr: '' };
  const d = decide(command);
  return d.block ? { code: 2, stderr: `${MESSAGE}\n` } : { code: 0, stderr: '' };
}

function main(): void {
  let text = '';
  try {
    text = readFileSync(0).subarray(0, MAX_INPUT_BYTES).toString('utf8');
  } catch {
    process.exitCode = 0;
    return;
  }
  const r = evaluate(text, process.env);
  if (r.stderr !== '') process.stderr.write(r.stderr);
  process.exitCode = r.code;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
