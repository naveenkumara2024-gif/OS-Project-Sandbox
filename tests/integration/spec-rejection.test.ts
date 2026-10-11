import { describe, expect, it } from 'vitest';
import { superviseCell } from '../../src/supervise/cell-supervisor.js';
import { encodeLaunchSpec, type LaunchSpec } from '../../src/sys/launch-spec.js';
import { parseStatus } from '../../src/sys/status.js';
import { helperBuilds } from '../helpers/cell.js';

// The native parser is the helper's only untrusted-input parser (CLAUDE.md 5.5). These tests hand
// it bytes the TypeScript encoder would never produce and require a refusal naming the spec layer,
// never a started payload.

const valid: LaunchSpec = {
  argv: ['/usr/bin/echo', 'MUST-NOT-RUN'],
  env: ['PATH=/usr/bin:/bin'],
  rootMountpoint: '/tmp/aegis-never-created/root',
  hostname: 'aegis',
  rootTmpfsBytes: 64 * 1024 * 1024,
  tmpTmpfsBytes: 16 * 1024 * 1024,
  entries: [],
  maskFiles: [],
  maskDirs: [],
  cgroupFd: false,
};

function good(): Buffer {
  const r = encodeLaunchSpec(valid);
  if (!r.ok) throw new Error(r.error.context);
  return Buffer.from(r.value);
}

/** Returns a valid spec with `mutate` applied in place to a copy. */
function withBytes(mutate: (b: Buffer) => void): Buffer {
  const b = good();
  mutate(b);
  return b;
}

/** A spec the encoder would refuse, made by patching the bytes of a valid one. */
function withOutsideSource(): Buffer {
  const r = encodeLaunchSpec({
    ...valid,
    entries: [{ kind: 'bind-dir', src: '/usr/bin', tgt: '/usr/bin' }],
  });
  if (!r.ok) throw new Error(r.error.context);
  const b = Buffer.from(r.value);
  const at = b.indexOf('/usr/bin\0/usr/bin\0', 0, 'latin1');
  if (at < 0) throw new Error('entry not found');
  b.write('/etc/bin', at, 'latin1'); // the bind source, now outside /usr
  return b;
}

const cases: [string, Buffer][] = [
  ['a bind source outside /usr', withOutsideSource()],
  ['empty input', Buffer.alloc(0)],
  ['wrong magic', withBytes((b) => void b.write('NOPE', 0, 'latin1'))],
  ['wrong version', withBytes((b) => void b.writeUInt16LE(2, 4))],
  ['non-zero reserved header field', withBytes((b) => void b.writeUInt16LE(1, 6))],
  ['length field larger than the input', withBytes((b) => void b.writeUInt32LE(b.length + 1, 8))],
  ['unknown record key', withBytes((b) => void b.writeUInt16LE(99, 12))],
  ['record length overruns the input', withBytes((b) => void b.writeUInt32LE(0x7fffffff, 16))],
  ['truncated mid-record', good().subarray(0, good().length - 3)],
  ['header only', Buffer.from('AEGS\x01\x00\x00\x00\x0c\x00\x00\x00', 'latin1')],
  ['over the size cap', Buffer.concat([good(), Buffer.alloc(70_000)])],
];

describe.each(helperBuilds())('launch spec rejection ($name build)', (helper) => {
  it.each(cases)('refuses %s', async (_name, bytes) => {
    const r = await superviseCell({
      helper: helper.path,
      spec: bytes,
      wallMs: 5000,
      maxOutputBytes: 4096,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stdout.toString()).not.toContain('MUST-NOT-RUN');
    const recs = parseStatus(r.value.status);
    expect(recs.ok).toBe(true);
    if (!recs.ok) return;
    expect(recs.value.some((x) => x.kind === 'started')).toBe(false);
    expect(recs.value.some((x) => x.kind === 'layer' && !x.ok && x.layer === 'spec')).toBe(true);
    expect(r.value.helperExitCode).toBe(65);
  });

  it('accepts the control: the same bytes unmodified reach the cell stage', async () => {
    // rootMountpoint does not exist, so this fails in the root layer, not the spec layer.
    const r = await superviseCell({
      helper: helper.path,
      spec: good(),
      wallMs: 5000,
      maxOutputBytes: 4096,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const recs = parseStatus(r.value.status);
    expect(recs.ok && recs.value.some((x) => x.kind === 'layer' && x.layer === 'spec')).toBe(false);
  });
});
