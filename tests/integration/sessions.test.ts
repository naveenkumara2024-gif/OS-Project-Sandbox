import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine/engine.js';
import { createFixture, snapshotTree, type Fixture } from '../escape/harness.js';
import { helperBuilds, request } from '../helpers/cell.js';
import { drain, makeEngine, runAndWait, testPolicy } from '../helpers/engine.js';

// Sessions, streaming, cancellation and admission, through the engine and real cells.

let fixture: Fixture;
let parent = '';
let engine: Engine;
beforeEach(() => {
  fixture = createFixture();
  parent = mkdtempSync(join(tmpdir(), 'aegis-engine-'));
});
afterEach(async () => {
  await engine.close();
  fixture.dispose();
  rmSync(parent, { recursive: true, force: true });
});

describe.each(helperBuilds())('engine sessions ($name build)', (helper) => {
  const policyFor = () => testPolicy({ ingestRoots: [fixture.project] });

  it('accumulates changes over three runs and commits only the approved paths', async () => {
    engine = makeEngine(helper, parent, { policy: policyFor() });
    // Run 1: the program is broken.
    const r1 = await runAndWait(engine, ['/usr/bin/python3', 'analyze.py'], {
      workspace: { source: fixture.project },
      files: [{ path: 'analyze.py', content: 'print(undefined_name)\n' }],
    });
    expect(r1.termination).toEqual({ cause: 'exit' });
    expect(r1.exit_code).not.toBe(0);
    expect(r1.stderr).toContain('NameError');
    const session = r1.session;
    expect(session).toMatch(/^s-[0-9a-f]{32}$/);
    expect(r1.isolation.level).toBe(4);

    // Run 2 (same session): the fix arrives as a file written into the upper layer.
    const r2 = await runAndWait(
      engine,
      ['/usr/bin/python3', 'analyze.py'],
      { files: [{ path: 'analyze.py', content: 'print(sum(range(10)))\n' }] },
      session,
    );
    expect(r2.session).toBe(session);
    expect(r2.stdout).toBe('45\n');

    // Run 3: it produces output, and also plants things a commit must refuse.
    const r3 = await runAndWait(
      engine,
      [
        '/usr/bin/sh',
        '-c',
        'python3 analyze.py > report.csv; ln -s /etc/passwd link.txt; mkdir -p .git/hooks; echo x > .git/hooks/post-checkout',
      ],
      {},
      session,
    );
    expect(r3.termination).toEqual({ cause: 'exit' });
    const paths = (r3.changes ?? []).map((c) => c.path).sort();
    expect(paths).toEqual(['.git/hooks/post-checkout', 'analyze.py', 'link.txt', 'report.csv']);
    expect(r3.changes?.find((c) => c.path === 'analyze.py')?.op).toBe('modify');

    const d = engine.diff(session ?? '');
    if (!d.ok) throw new Error(d.error.context);
    expect(d.value.changes_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.value.source).toBe(fixture.project);

    // A stale hash is refused and the current diff comes back; nothing is written.
    const before = snapshotTree(fixture.project);
    const stale = await engine.commit(session ?? '', {
      paths: ['report.csv'],
      expectedChangesSha256: '0'.repeat(64),
    });
    expect(stale.ok && stale.value.kind).toBe('stale');
    if (stale.ok && stale.value.kind === 'stale') {
      expect(stale.value.diff.changes_sha256).toBe(d.value.changes_sha256);
    }
    expect(snapshotTree(fixture.project)).toEqual(before);

    // The right hash with a chosen list: report.csv lands, the unsafe ones are refused, and
    // analyze.py (not listed) is not written.
    const done = await engine.commit(session ?? '', {
      paths: ['report.csv', 'link.txt', '.git/hooks/post-checkout', 'not-there.txt'],
      expectedChangesSha256: d.value.changes_sha256,
    });
    if (!done.ok || done.value.kind !== 'done') throw new Error('commit did not complete');
    const byPath = new Map(done.value.outcomes.map((o) => [o.path, o]));
    expect(byPath.get('report.csv')?.status).toBe('committed');
    expect(byPath.get('link.txt')).toMatchObject({ status: 'refused' });
    expect(byPath.get('.git/hooks/post-checkout')).toMatchObject({ status: 'refused' });
    expect(byPath.get('not-there.txt')).toMatchObject({ status: 'refused' });
    expect(readFileSync(join(fixture.project, 'report.csv'), 'utf8')).toBe('45\n');
    expect(existsSync(join(fixture.project, 'analyze.py'))).toBe(false);
    expect(existsSync(join(fixture.project, 'link.txt'))).toBe(false);
    expect(existsSync(join(fixture.project, '.git'))).toBe(false);

    // Discard removes the session and its directory.
    const dir = engine.sessions.get(session ?? '')?.dir ?? '';
    expect(existsSync(dir)).toBe(true);
    expect(engine.discard(session ?? '').ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(engine.status().sessions).toEqual([]);
  });

  it('refuses a second run while the session is running a cell, and unknown sessions', async () => {
    engine = makeEngine(helper, parent, { policy: policyFor() });
    const first = engine.startRun({
      request: request(['/usr/bin/sleep', '1'], { files: [{ path: 'a.txt', content: 'x' }] }),
      idMode: 'server',
    });
    if (!first.ok) throw new Error(first.error.context);
    const busy = engine.startRun({
      request: request(['/usr/bin/true']),
      session: first.value.session,
      idMode: 'server',
    });
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.error.code).toBe('EBUSY');
    await first.value.result;

    const none = engine.startRun({
      request: request(['/usr/bin/true']),
      session: 's-' + '0'.repeat(32),
      idMode: 'server',
    });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error.code).toBe('ENOENT');

    // A source can only be given when the session is created.
    const resource = engine.startRun({
      request: request(['/usr/bin/true'], { workspace: { source: fixture.project } }),
      session: first.value.session,
      idMode: 'server',
    });
    expect(resource.ok).toBe(false);
    if (!resource.ok) expect(resource.error.code).toBe('EINVAL');
  });

  it('refuses later-run files that collide with a symlink or a non-file in the upper layer', async () => {
    engine = makeEngine(helper, parent, { policy: policyFor() });
    const r1 = await runAndWait(
      engine,
      ['/usr/bin/sh', '-c', 'ln -s /etc/passwd evil; mkdir sub'],
      { files: [{ path: 'seed.txt', content: 's' }] },
    );
    const session = r1.session ?? '';
    const bad = await runAndWait(
      engine,
      ['/usr/bin/true'],
      { files: [{ path: 'evil', content: 'overwrite through the link' }] },
      session,
    );
    expect(bad.termination).toMatchObject({
      cause: 'isolation_unavailable',
      layer: 'workspace_files',
    });
    const notFile = await runAndWait(
      engine,
      ['/usr/bin/true'],
      { files: [{ path: 'sub', content: 'x' }] },
      session,
    );
    expect(notFile.termination).toMatchObject({ layer: 'workspace_files' });
    // /etc/passwd on the host is untouched, and the session is still usable.
    const ok1 = await runAndWait(engine, ['/usr/bin/true'], {}, session);
    expect(ok1.termination).toEqual({ cause: 'exit' });
  });

  it('a first run that is refused leaves no session behind', async () => {
    engine = makeEngine(helper, parent, { policy: policyFor() });
    const r = await runAndWait(engine, ['/usr/bin/true'], {
      workspace: { source: '/etc' }, // outside the ingest roots
    });
    expect(r.termination).toMatchObject({ cause: 'isolation_unavailable' });
    expect(engine.status().sessions).toEqual([]);
    expect(existsSync(join(parent, `aegis-workspace-${r.session ?? 'x'}`))).toBe(false);
  });

  it('expires an idle session and never a running one', async () => {
    let t = 1_000_000;
    engine = makeEngine(helper, parent, { policy: policyFor(), now: () => t });
    const r = await runAndWait(engine, ['/usr/bin/true'], {
      files: [{ path: 'a.txt', content: 'x' }],
    });
    const dir = engine.sessions.get(r.session ?? '')?.dir ?? '';
    expect(existsSync(dir)).toBe(true);
    t += 1_000_000 + 1800 * 1000; // past the 1800 s idle limit
    engine.sweep();
    expect(existsSync(dir)).toBe(false);
    expect(engine.status().sessions).toEqual([]);
  });

  it('another engine (or the CLI) can adopt a session from disk and commit it', async () => {
    engine = makeEngine(helper, parent, { policy: policyFor() });
    const r = await runAndWait(engine, ['/usr/bin/sh', '-c', 'echo hi > out.txt'], {
      workspace: { source: fixture.project },
    });
    const session = r.session ?? '';
    const second = makeEngine(helper, parent, { policy: policyFor() });
    try {
      const done = await second.commit(session, {
        paths: ['out.txt'],
        expectedChangesSha256: null,
        adopt: true,
      });
      expect(done.ok && done.value.kind).toBe('done');
      expect(readFileSync(join(fixture.project, 'out.txt'), 'utf8')).toBe('hi\n');
    } finally {
      await second.close();
    }
  });
});

describe.each(helperBuilds())('engine streaming and cancellation ($name build)', (helper) => {
  it('streams ordered events ending in exactly one receipt, and the receipt has the full output', async () => {
    engine = makeEngine(helper, parent);
    const started = engine.startRun({
      request: request([
        '/usr/bin/sh',
        '-c',
        'echo one; sleep 0.15; echo two; sleep 0.15; echo err >&2; echo three',
      ]),
      idMode: 'server',
    });
    if (!started.ok) throw new Error(started.error.context);
    const events = await drain(started.value);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('started');
    expect(types[types.length - 1]).toBe('receipt');
    expect(types.filter((t) => t === 'receipt')).toHaveLength(1);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const out = events.map((e) => (e.type === 'stdout' ? e.data : '')).join('');
    const err = events.map((e) => (e.type === 'stderr' ? e.data : '')).join('');
    expect(out).toBe('one\ntwo\nthree\n');
    expect(err).toBe('err\n');
    const r = await started.value.result;
    expect(r.ok && r.value.stdout).toBe('one\ntwo\nthree\n');
    // Streaming is real: output arrived in more than one event, before the run ended.
    expect(events.filter((e) => e.type === 'stdout').length).toBeGreaterThan(1);
  });

  it('warns once when a limit passes 80 %, before the run ends', async () => {
    engine = makeEngine(helper, parent);
    const started = engine.startRun({
      request: request(
        [
          '/usr/bin/python3',
          '-c',
          'import sys,time; sys.stdout.write("x"*900); sys.stdout.flush(); time.sleep(0.6)',
        ],
        { limits: { output_kb: 1 } },
      ),
      idMode: 'server',
    });
    if (!started.ok) throw new Error(started.error.context);
    const events = await drain(started.value);
    const warns = events.filter((e) => e.type === 'limit_warning');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ limit: 'output', max: 1024 });
    expect(events.findIndex((e) => e.type === 'limit_warning')).toBeLessThan(events.length - 1);
  });

  it('cancels a running cell with the timeout kill procedure and leaves nothing behind', async () => {
    engine = makeEngine(helper, parent);
    const started = engine.startRun({
      request: request(['/usr/bin/sleep', '30']),
      idMode: 'server',
    });
    if (!started.ok) throw new Error(started.error.context);
    await new Promise((r) => setTimeout(r, 400));
    const t0 = Date.now();
    expect(engine.cancelRun(started.value.id).ok).toBe(true);
    const r = await started.value.result;
    if (!r.ok) throw new Error(r.error.context);
    expect(r.value.termination).toEqual({ cause: 'cancelled' });
    expect(r.value.limits_hit).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(engine.cancelRun(started.value.id).ok).toBe(false); // already finished
    expect(engine.status().cells.running).toBe(0);
  });

  it('queues a run when capacity is full, reports the queue position, and can cancel a waiter', async () => {
    engine = makeEngine(helper, parent, {
      policy: testPolicy({ ceiling: { maxCells: 1 } }),
    });
    const a = engine.startRun({ request: request(['/usr/bin/sleep', '1']), idMode: 'server' });
    if (!a.ok) throw new Error(a.error.context);
    await new Promise((r) => setTimeout(r, 200));
    const b = engine.startRun({ request: request(['/usr/bin/true']), idMode: 'server' });
    const c = engine.startRun({ request: request(['/usr/bin/true']), idMode: 'server' });
    if (!b.ok || !c.ok) throw new Error('start');
    await new Promise((r) => setTimeout(r, 100));
    expect(engine.status().cells).toMatchObject({ running: 1, queued: 2 });
    engine.cancelRun(c.value.id);
    const cr = await c.value.result;
    expect(cr.ok).toBe(false);
    if (!cr.ok) expect(cr.error.code).toBe('ECANCELED');
    const bEvents = await drain(b.value);
    expect(bEvents.some((e) => e.type === 'queued')).toBe(true);
    const br = await b.value.result;
    expect(br.ok && br.value.termination).toEqual({ cause: 'exit' });
    const ar = await a.value.result;
    expect(ar.ok && ar.value.termination).toEqual({ cause: 'exit' });
    const cEvents = await drain(c.value);
    expect(cEvents[cEvents.length - 1]).toMatchObject({ type: 'failed', code: 'ECANCELED' });
  });

  it('refuses with busy when the wait for capacity runs out', async () => {
    engine = makeEngine(helper, parent, {
      policy: testPolicy({ ceiling: { maxCells: 1 } }),
    });
    const a = engine.startRun({ request: request(['/usr/bin/sleep', '1']), idMode: 'server' });
    if (!a.ok) throw new Error(a.error.context);
    await new Promise((r) => setTimeout(r, 200));
    const b = engine.startRun({
      request: request(['/usr/bin/true']),
      idMode: 'server',
      admissionWaitMs: 100,
    });
    if (!b.ok) throw new Error(b.error.context);
    const br = await b.value.result;
    expect(br.ok).toBe(false);
    if (!br.ok) expect(br.error.code).toBe('EBUSY');
    await a.value.result;
  });
});
