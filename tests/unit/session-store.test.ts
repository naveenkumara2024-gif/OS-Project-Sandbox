import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseSessionFile,
  SERVER_ID,
  SESSION_FILE,
  sessionFileSchema,
} from '../../src/engine/session.js';
import { SessionStore } from '../../src/engine/session-store.js';

let parent = '';
let t = 1_000_000;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'aegis-sessions-'));
  t = 1_000_000;
});
afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

const store = (over: Partial<ConstructorParameters<typeof SessionStore>[0]> = {}) =>
  new SessionStore({ parent, maxSessions: 3, idleMs: 60_000, now: () => t, ...over });

function materialise(s: { dir: string; upper: string; lower: string }): void {
  mkdirSync(s.lower, { recursive: true });
  mkdirSync(s.upper, { recursive: true });
  writeFileSync(join(s.upper, 'f.txt'), 'x');
}

describe('SessionStore', () => {
  it('creates a running session, refuses a duplicate and a bad id', () => {
    const st = store();
    const s = st.create('s-' + 'a'.repeat(32), null);
    expect(s.ok).toBe(true);
    expect(st.create('s-' + 'a'.repeat(32), null).ok).toBe(false);
    for (const bad of ['../x', 'a/b', '', 'x'.repeat(65), 'a b', '.. ']) {
      expect(st.create(bad, null).ok, bad).toBe(false);
    }
  });

  it('allows one run at a time: begin refuses while running, end frees it', () => {
    const st = store();
    const s = st.create('one', null);
    if (!s.ok) throw new Error('create');
    expect(st.begin('one').ok).toBe(false); // created in the running state
    st.end('one', 'overlay');
    expect(st.get('one')?.state).toBe('idle');
    expect(st.get('one')?.mode).toBe('overlay');
    expect(st.get('one')?.runs).toBe(1);
    expect(st.begin('one').ok).toBe(true);
    const second = st.begin('one');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('EBUSY');
    expect(st.begin('nope').ok).toBe(false);
  });

  it('evicts the oldest idle session when full, and refuses when none is idle', () => {
    const st = store();
    for (const id of ['a', 'b', 'c']) {
      const s = st.create(id, null);
      if (!s.ok) throw new Error('create');
      materialise(s.value);
      t += 10;
      st.end(id, 'overlay');
    }
    t += 10;
    st.begin('a'); // a is running; b is now the oldest idle
    const d = st.create('d', null);
    expect(d.ok).toBe(true);
    expect(st.get('b')).toBeUndefined();
    expect(existsSync(join(parent, 'aegis-workspace-b'))).toBe(false);
    expect(st.get('a')).toBeDefined();
    // a running, c idle, d running -> evict c; then a, d running, e running -> full of running
    expect(st.create('e', null).ok).toBe(true);
    const f = st.create('f', null);
    expect(f.ok).toBe(false);
    if (!f.ok) expect(f.error.code).toBe('EBUSY');
  });

  it('expires idle sessions after the idle limit, never a running one', () => {
    const st = store();
    for (const id of ['i', 'r']) {
      const s = st.create(id, null);
      if (!s.ok) throw new Error('create');
      materialise(s.value);
    }
    st.end('i', 'overlay');
    t += 59_000;
    expect(st.expireIdle()).toEqual([]);
    t += 2_000;
    expect(st.expireIdle()).toEqual(['i']);
    expect(existsSync(join(parent, 'aegis-workspace-i'))).toBe(false);
    expect(st.get('r')?.state).toBe('running');
    expect(existsSync(join(parent, 'aegis-workspace-r'))).toBe(true);
  });

  it('persists session.json through the strict schema and adopts it back', () => {
    const a = store();
    const s = a.create('keep', '/srv/project');
    if (!s.ok) throw new Error('create');
    materialise(s.value);
    a.end('keep', 'overlay');
    const text = readFileSync(join(s.value.dir, SESSION_FILE), 'utf8');
    expect(parseSessionFile(text).ok).toBe(true);
    expect((s.value as { dir: string }).dir).toContain('aegis-workspace-keep');

    const b = store(); // a second engine (or the CLI) finds it on disk
    const adopted = b.adopt('keep');
    expect(adopted.ok).toBe(true);
    if (adopted.ok) {
      expect(adopted.value.source).toBe('/srv/project');
      expect(adopted.value.mode).toBe('overlay');
      expect(adopted.value.state).toBe('idle');
    }
    expect(b.adopt('missing').ok).toBe(false);
  });

  it('refuses to adopt a directory with a bad, mismatched or oversize session file', () => {
    const st = store();
    const dir = join(parent, 'aegis-workspace-bad');
    mkdirSync(dir);
    for (const body of [
      '{not json',
      JSON.stringify({ v: 1, id: 'bad', extra: 1 }),
      JSON.stringify({
        v: 1,
        id: 'other',
        owner_pid: 1,
        created_ms: 1,
        last_used_ms: 1,
        source: null,
        mode: null,
        state: 'idle',
      }),
      'x'.repeat(5000),
    ]) {
      writeFileSync(join(dir, SESSION_FILE), body);
      expect(st.adopt('bad').ok, body.slice(0, 20)).toBe(false);
    }
  });

  it('the startup sweep removes only dead, old, recognised sessions', () => {
    const mk = (id: string, pid: number, last: number, valid = true) => {
      const dir = join(parent, `aegis-workspace-${id}`);
      mkdirSync(join(dir, 'rw', 'upper'), { recursive: true });
      writeFileSync(
        join(dir, SESSION_FILE),
        valid
          ? JSON.stringify({
              v: 1,
              id,
              owner_pid: pid,
              created_ms: last,
              last_used_ms: last,
              source: null,
              mode: 'overlay',
              state: 'idle',
            })
          : 'garbage',
      );
      return dir;
    };
    const oldDead = mk('old-dead', 999_001, t - 120_000);
    const oldLive = mk('old-live', 1, t - 120_000);
    const freshDead = mk('fresh-dead', 999_001, t - 1_000);
    const garbage = mk('garbage', 999_001, t - 120_000, false);
    const stage3 = join(parent, 'aegis-workspace-stage3');
    mkdirSync(stage3);
    const st = store({ isAlive: (pid) => pid === 1 });
    expect(st.sweepOrphans()).toEqual(['old-dead']);
    expect(existsSync(oldDead)).toBe(false);
    for (const kept of [oldLive, freshDead, garbage, stage3]) expect(existsSync(kept)).toBe(true);
  });
});

describe('session ids and schema', () => {
  it('server ids are s- plus 32 hex digits', () => {
    expect(SERVER_ID.test('s-' + '0123456789abcdef'.repeat(2))).toBe(true);
    for (const bad of [
      's-',
      's-xyz',
      'S-' + 'a'.repeat(32),
      's-' + 'a'.repeat(31),
      's-' + 'a'.repeat(33),
    ]) {
      expect(SERVER_ID.test(bad), bad).toBe(false);
    }
  });

  it('the schema rejects unknown keys, bad states and prototype keys', () => {
    const good = {
      v: 1,
      id: 'x',
      owner_pid: 5,
      created_ms: 1,
      last_used_ms: 2,
      source: null,
      mode: null,
      state: 'idle',
    };
    expect(sessionFileSchema.safeParse(good).success).toBe(true);
    for (const bad of [
      { ...good, extra: 1 },
      { ...good, state: 'dead' },
      { ...good, owner_pid: 0 },
      { ...good, id: '../x' },
      { ...good, v: 2 },
    ]) {
      expect(sessionFileSchema.safeParse(bad).success).toBe(false);
    }
    expect(parseSessionFile('{"__proto__":{"x":1},"v":1}').ok).toBe(false);
  });
});
