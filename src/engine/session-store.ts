import { lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discardWorkspace } from '../collect/discard.js';
import { pidIsAlive } from '../launch/cgroup.js';
import { err, errFromException, ok, type Result } from '../util/result.js';
import {
  CLIENT_ID,
  parseSessionFile,
  SESSION_FILE,
  toSessionFile,
  type Session,
} from './session.js';

export interface SessionStoreOptions {
  /** Directory that holds `aegis-workspace-<id>` directories (the OS temp directory by default). */
  readonly parent: string;
  readonly maxSessions: number;
  readonly idleMs: number;
  readonly now?: () => number;
  readonly pid?: number;
  readonly isAlive?: (pid: number) => boolean;
  /** Test seam: process uid, to check directory ownership. */
  readonly uid?: number;
}

const DIR_PREFIX = 'aegis-workspace-';

/**
 * The engine's table of sessions. Memory is the source of truth for the live engine; the files
 * exist so the one-shot CLI (`aegis commit <id>`) and the startup sweep can find a session after
 * the engine that made it is gone.
 */
export class SessionStore {
  readonly #opts: SessionStoreOptions;
  readonly #sessions = new Map<string, Session>();
  readonly #now: () => number;

  constructor(opts: SessionStoreOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? (() => Date.now());
  }

  dirFor(id: string): Result<string> {
    if (!CLIENT_ID.test(id)) return err('EINVAL', 'session id has unexpected characters');
    return ok(join(this.#opts.parent, `${DIR_PREFIX}${id}`));
  }

  #make(id: string, dir: string, source: string | null, now: number, pid: number): Session {
    return {
      id,
      dir,
      lower: join(dir, 'lower'),
      rw: join(dir, 'rw'),
      upper: join(dir, 'rw', 'upper'),
      source,
      mode: null,
      state: 'running',
      createdMs: now,
      lastUsedMs: now,
      runs: 0,
      ownerPid: pid,
    };
  }

  /**
   * Registers a new session in the `running` state. The directory itself is created by the first
   * run. When the table is full the oldest idle session is expired to make room; if none is idle
   * the new session is refused.
   */
  create(id: string, source: string | null): Result<Session> {
    const dir = this.dirFor(id);
    if (!dir.ok) return dir;
    if (this.#sessions.has(id)) return err('EEXIST', 'a session with this id already exists');
    if (this.#sessions.size >= this.#opts.maxSessions) {
      const idle = [...this.#sessions.values()]
        .filter((s) => s.state === 'idle')
        .sort((a, b) => a.lastUsedMs - b.lastUsedMs)[0];
      if (idle === undefined) return err('EBUSY', 'too many sessions and none is idle');
      this.discard(idle.id);
    }
    const s = this.#make(id, dir.value, source, this.#now(), this.#opts.pid ?? process.pid);
    this.#sessions.set(id, s);
    return ok(s);
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  list(): Session[] {
    return [...this.#sessions.values()];
  }

  /** Marks a session as running one cell; a second run at the same time is refused. */
  begin(id: string): Result<Session> {
    const s = this.#sessions.get(id);
    if (s === undefined) return err('ENOENT', 'no such session');
    if (s.state === 'running') return err('EBUSY', 'the session is already running a cell');
    s.state = 'running';
    s.lastUsedMs = this.#now();
    this.persist(s);
    return ok(s);
  }

  end(id: string, mode: 'overlay' | 'copy' | null): void {
    const s = this.#sessions.get(id);
    if (s === undefined) return;
    s.state = 'idle';
    s.lastUsedMs = this.#now();
    s.runs += 1;
    if (mode !== null) s.mode = mode;
    this.persist(s);
  }

  /** Writes `session.json` if the directory exists. Best effort: failure is not a run failure. */
  persist(s: Session): void {
    try {
      if (!lstatSync(s.dir).isDirectory()) return;
      const tmp = join(s.dir, `${SESSION_FILE}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(toSessionFile(s))}\n`, { mode: 0o600 });
      renameSync(tmp, join(s.dir, SESSION_FILE));
    } catch {
      // The directory may not exist yet (the first run creates it) or may be gone (discarded).
    }
  }

  /** Loads a session another engine process (or the CLI's earlier run) left on disk. */
  adopt(id: string): Result<Session> {
    const existing = this.#sessions.get(id);
    if (existing !== undefined) return ok(existing);
    const dir = this.dirFor(id);
    if (!dir.ok) return dir;
    try {
      const st = lstatSync(dir.value);
      const uid = this.#opts.uid ?? process.getuid?.() ?? -1;
      if (!st.isDirectory() || st.uid !== uid) {
        return err('EACCES', 'workspace is not a directory owned by this user');
      }
      const parsed = parseSessionFile(readFileSync(join(dir.value, SESSION_FILE), 'utf8'));
      if (!parsed.ok) return parsed;
      if (parsed.value.id !== id) return err('EINVAL', 'session file names another session');
      const s = this.#make(
        id,
        dir.value,
        parsed.value.source,
        parsed.value.created_ms,
        parsed.value.owner_pid,
      );
      s.mode = parsed.value.mode;
      s.state = 'idle';
      s.lastUsedMs = parsed.value.last_used_ms;
      this.#sessions.set(id, s);
      return ok(s);
    } catch (e) {
      return errFromException(e, 'adopt session');
    }
  }

  discard(id: string): Result<void> {
    const known = this.#sessions.get(id);
    let dir: string;
    if (known !== undefined) {
      dir = known.dir;
    } else {
      const d = this.dirFor(id);
      if (!d.ok) return d;
      dir = d.value;
    }
    this.#sessions.delete(id);
    return discardWorkspace({ dir });
  }

  /** Expires idle sessions older than the idle limit. Returns the ids removed. */
  expireIdle(): string[] {
    const now = this.#now();
    const gone: string[] = [];
    for (const s of [...this.#sessions.values()]) {
      if (s.state === 'idle' && now - s.lastUsedMs > this.#opts.idleMs) {
        this.discard(s.id);
        gone.push(s.id);
      }
    }
    return gone;
  }

  /**
   * Startup sweep: removes session directories whose owner process is dead and whose last use is
   * older than the idle limit. A directory without a valid `session.json` (a Stage 3 workspace,
   * or anything else) is left alone: it is not ours to delete.
   */
  sweepOrphans(): string[] {
    const isAlive = this.#opts.isAlive ?? pidIsAlive;
    const now = this.#now();
    const removed: string[] = [];
    let names: string[];
    try {
      names = readdirSync(this.#opts.parent).filter((n) => n.startsWith(DIR_PREFIX));
    } catch {
      return removed;
    }
    for (const name of names) {
      const id = name.slice(DIR_PREFIX.length);
      if (this.#sessions.has(id) || !CLIENT_ID.test(id)) continue;
      const dir = join(this.#opts.parent, name);
      try {
        const st = lstatSync(dir);
        if (!st.isDirectory() || st.uid !== (this.#opts.uid ?? process.getuid?.() ?? -1)) continue;
        const parsed = parseSessionFile(readFileSync(join(dir, SESSION_FILE), 'utf8'));
        if (!parsed.ok || parsed.value.id !== id) continue;
        if (isAlive(parsed.value.owner_pid)) continue;
        if (now - parsed.value.last_used_ms <= this.#opts.idleMs) continue;
        if (discardWorkspace({ dir }).ok) removed.push(id);
      } catch {
        continue;
      }
    }
    return removed;
  }
}
