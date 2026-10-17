import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine/engine.js';
import { Gateway } from '../../src/gateway/server.js';
import { helperBuilds, request } from '../helpers/cell.js';
import { makeEngine, runAndWait, testPolicy } from '../helpers/engine.js';
import { createFixture, snapshotTree, type Fixture } from './harness.js';

// Probe 23 (Stage 5): confuse the session model. Guess or traverse ids, reach another session's
// files, commit to a place the policy does not allow (directly, through a symlink, by swapping the
// destination), commit things that were never in the change list, commit against a diff that has
// changed, and commit while a cell is running. Layers expected to stop it: unguessable ids, the
// private root of each cell, the commit policy and `fsop`, and the diff-hash binding.

let fixture: Fixture;
let parent = '';
let engine: Engine;
beforeEach(() => {
  fixture = createFixture();
  parent = mkdtempSync(join(tmpdir(), 'aegis-p23-'));
});
afterEach(async () => {
  await engine.close();
  fixture.dispose();
  rmSync(parent, { recursive: true, force: true });
});

describe.each(helperBuilds())('probe 23: session confusion ($name build)', (helper) => {
  const policy = () => testPolicy({ ingestRoots: [fixture.project] });

  it("another session's files are not visible from a cell, by name or by content", async () => {
    engine = makeEngine(helper, parent, { policy: policy() });
    const a = await runAndWait(engine, ['/usr/bin/true'], {
      files: [{ path: 'a-secret.txt', content: 'A-SECRET-CONTENT\n' }],
    });
    const b = await runAndWait(
      engine,
      [
        '/usr/bin/sh',
        '-c',
        // The literal is split so this command line does not contain it (/proc/*/cmdline would).
        'find / -xdev -name "a-secret*" 2>/dev/null; find /proc -maxdepth 0; ' +
          "grep -rl --exclude-dir=proc --exclude-dir=usr 'A-SECRET-''CONTENT' / 2>/dev/null; " +
          'ls -a /workspace; ls /',
      ],
      { files: [{ path: 'b.txt', content: 'b\n' }] },
    );
    expect(a.session).not.toBe(b.session);
    expect(b.stdout).not.toContain('A-SECRET');
    expect(b.stdout).not.toContain('a-secret');
    expect(b.stdout).toContain('b.txt');
  });

  it('the gateway never confirms a guessed, traversed or foreign-format session id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aegis-p23g-'));
    chmodSync(root, 0o700);
    const sock = join(root, 'aegis', 'gateway.sock');
    engine = makeEngine(helper, parent, { policy: policy() });
    const real = await runAndWait(engine, ['/usr/bin/true'], {
      files: [{ path: 'x', content: 'x' }],
    });
    const g = await Gateway.start({ socketPath: sock, engine });
    if (!g.ok) throw new Error(g.error.context);
    const get = (path: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = httpRequest({ socketPath: sock, path, method: 'GET' }, (res) => {
          res.resume();
          res.on('end', () => {
            resolve(res.statusCode ?? 0);
          });
        });
        req.on('error', reject);
        req.end();
      });
    try {
      const ok1 = await get(`/v1/sessions/${real.session ?? ''}/diff`);
      expect(ok1).toBe(200); // control: the real id works
      const sid = real.session ?? '';
      const wrongs = [
        `/v1/sessions/s-${'0'.repeat(32)}/diff`,
        `/v1/sessions/${sid.slice(0, -1)}0/diff`, // one hex digit off
        `/v1/sessions/${sid.toUpperCase()}/diff`,
        `/v1/sessions/${sid}/../${sid}/diff`,
        `/v1/sessions/../runs/${sid}`,
        `/v1/sessions/${sid.replace('s-', 'r-')}/diff`,
        '/v1/sessions/aegis-workspace-x/diff',
        '/v1/sessions/q-0123456789abcdef/diff',
      ];
      for (const w of wrongs) expect(await get(w), w).toBe(404);
    } finally {
      await g.value.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to commit outside the policy: a path, a symlink to it, another destination', async () => {
    engine = makeEngine(helper, parent, { policy: policy() });
    mkdirSync(join(fixture.root, 'elsewhere'));
    symlinkSync('/etc', join(fixture.project, 'escape'));
    const before = snapshotTree(fixture.root);
    const inline = await runAndWait(engine, ['/usr/bin/sh', '-c', 'echo data > out.txt'], {
      files: [{ path: 'seed.txt', content: 's' }],
    });
    const sid = inline.session ?? '';
    const d = engine.diff(sid);
    if (!d.ok) throw new Error(d.error.context);
    const attempts = [
      '/tmp',
      '/etc',
      join(fixture.root, 'elsewhere'), // exists, but is not a commit root
      join(fixture.project, 'escape'), // inside the root, resolves to /etc
      join(fixture.project, '..'),
      `${fixture.project}/../elsewhere`,
    ];
    for (const dest of attempts) {
      const r = await engine.commit(sid, {
        paths: ['out.txt'],
        expectedChangesSha256: d.value.changes_sha256,
        dest,
      });
      expect(r.ok, dest).toBe(false);
      if (!r.ok) expect(r.error.code, dest).toBe('EACCES');
    }
    expect(snapshotTree(fixture.root)).toEqual(before);
    expect(existsSync('/etc/out.txt')).toBe(false);
    // Control: the one allowed root works.
    const good = await engine.commit(sid, {
      paths: ['out.txt'],
      expectedChangesSha256: d.value.changes_sha256,
      dest: fixture.project,
    });
    expect(good.ok && good.value.kind).toBe('done');
    expect(existsSync(join(fixture.project, 'out.txt'))).toBe(true);
  });

  it('a session with a source cannot be redirected to another destination', async () => {
    engine = makeEngine(helper, parent, { policy: policy() });
    const r = await runAndWait(engine, ['/usr/bin/sh', '-c', 'echo x > o.txt'], {
      workspace: { source: fixture.project },
    });
    const d = engine.diff(r.session ?? '');
    if (!d.ok) throw new Error(d.error.context);
    const moved = await engine.commit(r.session ?? '', {
      paths: ['o.txt'],
      expectedChangesSha256: d.value.changes_sha256,
      dest: join(fixture.root, 'elsewhere'),
    });
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.error.code).toBe('EINVAL');
  });

  it('commits only what is in the change list: a path through a planted symlink is refused', async () => {
    engine = makeEngine(helper, parent, { policy: policy() });
    const r = await runAndWait(
      engine,
      ['/usr/bin/sh', '-c', `ln -s ${fixture.home} link; echo mine > mine.txt`],
      { workspace: { source: fixture.project } },
    );
    const sid = r.session ?? '';
    const d = engine.diff(sid);
    if (!d.ok) throw new Error(d.error.context);
    const before = snapshotTree(fixture.root);
    const done = await engine.commit(sid, {
      paths: ['link/.ssh/id_rsa', 'link', '../home/.ssh/id_rsa', '/etc/passwd', 'mine.txt'],
      expectedChangesSha256: d.value.changes_sha256,
    });
    if (!done.ok || done.value.kind !== 'done') throw new Error('commit did not complete');
    const by = new Map(done.value.outcomes.map((o) => [o.path, o.status]));
    expect(by.get('mine.txt')).toBe('committed');
    for (const p of ['link/.ssh/id_rsa', 'link', '../home/.ssh/id_rsa', '/etc/passwd']) {
      expect(by.get(p), p).toBe('refused');
    }
    // Only mine.txt was added anywhere in the fixture; the decoy secrets are untouched.
    const after = snapshotTree(fixture.root);
    const changed = [...after.keys()].filter((k) => before.get(k) !== after.get(k));
    expect(changed).toEqual(['project/mine.txt']);
  });

  it('a commit against a diff that has since changed is refused, and a running session cannot be committed', async () => {
    engine = makeEngine(helper, parent, { policy: policy() });
    const r1 = await runAndWait(engine, ['/usr/bin/sh', '-c', 'echo v1 > f.txt'], {
      workspace: { source: fixture.project },
    });
    const sid = r1.session ?? '';
    const reviewed = engine.diff(sid);
    if (!reviewed.ok) throw new Error(reviewed.error.context);
    // After review, the program changes the file again (what a prompt-injected run would do).
    await runAndWait(engine, ['/usr/bin/sh', '-c', 'echo v2-malicious > f.txt'], {}, sid);
    const stale = await engine.commit(sid, {
      paths: ['f.txt'],
      expectedChangesSha256: reviewed.value.changes_sha256,
    });
    expect(stale.ok && stale.value.kind).toBe('stale');
    expect(existsSync(join(fixture.project, 'f.txt'))).toBe(false);

    // And while a cell is running, neither diff nor commit is allowed.
    const running = engine.startRun({
      request: request(['/usr/bin/sleep', '1']),
      session: sid,
      idMode: 'server',
    });
    if (!running.ok) throw new Error(running.error.context);
    const during = await engine.commit(sid, {
      paths: ['f.txt'],
      expectedChangesSha256: reviewed.value.changes_sha256,
    });
    expect(during.ok).toBe(false);
    if (!during.ok) expect(during.error.code).toBe('EBUSY');
    await running.value.result;
  });
});
