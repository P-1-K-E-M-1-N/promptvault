// Local SQLite database with an FTS5 full-text index.
// Uses Node's built-in node:sqlite, so there is nothing native to compile.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// node:sqlite prints an "experimental" warning on some Node versions; hide just that one.
const originalEmit = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const msg = typeof warning === 'string' ? warning : warning?.message;
  if (msg && /SQLite/i.test(msg)) return;
  return originalEmit.call(process, warning, ...args);
};
const { DatabaseSync } = await import('node:sqlite');

export function defaultDataDir() {
  if (process.env.PROMPTVAULT_HOME) return path.resolve(process.env.PROMPTVAULT_HOME);
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'promptvault');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'promptvault');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'promptvault');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, source TEXT, size INTEGER, mtime INTEGER, indexed_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, project TEXT, title TEXT,
  started_at INTEGER, ended_at INTEGER, file TEXT, n_messages INTEGER, n_prompts INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_file ON sessions(file);
CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
  role TEXT, kind TEXT, text TEXT, ts INTEGER
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS messages_kind_ts ON messages(kind, ts);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TABLE IF NOT EXISTS stars (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT, source TEXT, project TEXT,
  session_title TEXT, ts INTEGER, starred_at INTEGER, PRIMARY KEY (session_id, seq)
);
`;

const COUNT_CAP = 10000;
export const MIN_NODE = '24';

// Turn what a person types into a safe FTS5 query. Every word is prefix-matched,
// "quoted phrases" stay phrases, and punctuation can never cause a syntax error.
export function toFtsQuery(input) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(input || '')))) {
    if (m[1] !== undefined) {
      const words = m[1].split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      if (words.length) out.push(`"${words.join(' ')}"`);
    } else {
      const words = m[2].split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      if (words.length === 1) out.push(`"${words[0]}"*`);
      else if (words.length > 1) out.push(`"${words.join(' ')}"`); // foo-bar, a.b.c → phrase
    }
  }
  return out.join(' ');
}

export function openStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;');
  try {
    db.exec(SCHEMA);
  } catch (err) {
    if (/fts5/i.test(err.message)) {
      db.close();
      throw new Error(`Your Node.js ${process.versions.node} was built without SQLite full-text search (FTS5). Please install Node.js ${MIN_NODE} or newer from nodejs.org.`);
    }
    throw err;
  }

  const q = {
    getFile: db.prepare('SELECT size, mtime FROM files WHERE path = ?'),
    putFile: db.prepare('INSERT OR REPLACE INTO files(path, source, size, mtime, indexed_at) VALUES (?, ?, ?, ?, ?)'),
    sessionsForFile: db.prepare('SELECT id FROM sessions WHERE file = ?'),
    delMessages: db.prepare('DELETE FROM messages WHERE session_id = ?'),
    delSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    putSession: db.prepare(`INSERT OR REPLACE INTO sessions(id, source, project, title, started_at, ended_at, file, n_messages, n_prompts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    putMessage: db.prepare('INSERT INTO messages(session_id, seq, role, kind, text, ts) VALUES (?, ?, ?, ?, ?, ?)'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    putMeta: db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)'),
  };

  const store = {
    db,
    path: dbPath,

    getMeta(key) { return q.getMeta.get(key)?.value ?? null; },
    setMeta(key, value) { q.putMeta.run(key, String(value)); },

    fileUnchanged(file, size, mtime) {
      const row = q.getFile.get(file);
      return !!row && row.size === size && row.mtime === mtime;
    },
    markFile(file, source, size, mtime) { q.putFile.run(file, source, size, mtime, Date.now()); },

    removeSessionsForFile(file) {
      const ids = q.sessionsForFile.all(file).map((r) => r.id);
      for (const id of ids) { q.delMessages.run(id); q.delSession.run(id); }
      return ids.length;
    },

    removeSession(id) { q.delMessages.run(id); q.delSession.run(id); },

    // Writes one normalized session. Callers wrap this in a transaction.
    insertSession(s, file) {
      store.insertMessages(s, 0, s.messages.length, true);
      store.finishSession(s, file);
    },

    // Lets the indexer write a huge session in slices, yielding between them.
    insertMessages(s, from, to, clear = from === 0) {
      if (clear) q.delMessages.run(s.id);
      for (let seq = from; seq < to; seq++) {
        const m = s.messages[seq];
        q.putMessage.run(s.id, seq, m.role, m.kind, m.text, m.ts ?? null);
      }
    },

    finishSession(s, file) {
      let ended = s.started_at ?? null;
      let prompts = 0;
      for (const m of s.messages) {
        if (m.kind === 'user_prompt') prompts++;
        if (m.ts && (!ended || m.ts > ended)) ended = m.ts;
      }
      q.putSession.run(s.id, s.source, s.project ?? null, s.title ?? null, s.started_at ?? null, ended, file ?? null, s.messages.length, prompts);
    },

    transaction(fn) {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },

    totals() {
      const t = db.prepare(`SELECT COUNT(*) AS sessions, COUNT(DISTINCT COALESCE(project, source)) AS projects,
        COALESCE(SUM(n_messages), 0) AS messages, COALESCE(SUM(n_prompts), 0) AS prompts FROM sessions`).get();
      const bySource = db.prepare(`SELECT source, COUNT(*) AS sessions, COUNT(DISTINCT project) AS projects,
        COALESCE(SUM(n_prompts), 0) AS prompts FROM sessions GROUP BY source ORDER BY sessions DESC`).all();
      const stars = db.prepare('SELECT COUNT(*) AS n FROM stars').get().n;
      return { ...t, stars, bySource };
    },

    facets() {
      return {
        sources: db.prepare('SELECT source, COUNT(*) AS n FROM sessions GROUP BY source ORDER BY n DESC').all(),
        projects: db.prepare(`SELECT project, source, COUNT(*) AS n FROM sessions WHERE project IS NOT NULL
          GROUP BY project ORDER BY MAX(COALESCE(ended_at, started_at)) DESC`).all(),
      };
    },

    search({ q: text = '', kinds = [], source, project, from, to, sort = 'relevance', limit = 50, offset = 0 } = {}) {
      const where = [];
      const params = [];
      const fts = toFtsQuery(text);
      if (kinds.length) { where.push(`m.kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
      if (source) { where.push('s.source = ?'); params.push(source); }
      if (project) { where.push('s.project = ?'); params.push(project); }
      if (from) { where.push('COALESCE(m.ts, s.started_at) >= ?'); params.push(Number(from)); }
      if (to) { where.push('COALESCE(m.ts, s.started_at) <= ?'); params.push(Number(to)); }
      limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
      offset = Math.max(Number(offset) || 0, 0);

      if (fts) {
        const filter = where.length ? ' AND ' + where.join(' AND ') : '';
        const order = sort === 'newest' ? 'COALESCE(m.ts, s.started_at) DESC' : sort === 'oldest' ? 'COALESCE(m.ts, s.started_at) ASC' : 'rank';
        const base = `FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid JOIN sessions s ON s.id = m.session_id
          WHERE messages_fts MATCH ?${filter}`;
        const rows = db.prepare(`SELECT m.session_id, m.seq, m.role, m.kind, m.ts, s.title, s.source, s.project,
            snippet(messages_fts, 0, char(1), char(2), '…', 28) AS snippet
          ${base} ORDER BY ${order} LIMIT ? OFFSET ?`).all(fts, ...params, limit, offset);
        // Counting every match of a common word is slow on big indexes, so cap it.
        const total = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 ${base} LIMIT ${COUNT_CAP + 1})`).get(fts, ...params).n;
        return { total: Math.min(total, COUNT_CAP), capped: total > COUNT_CAP, rows };
      }

      // No query: browse newest first (uses the kind+ts index).
      const filter = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = db.prepare(`SELECT m.session_id, m.seq, m.role, m.kind, m.ts, s.title, s.source, s.project,
          substr(m.text, 1, 400) AS snippet
        FROM messages m JOIN sessions s ON s.id = m.session_id ${filter}
        ORDER BY m.ts DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      const total = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages m JOIN sessions s ON s.id = m.session_id ${filter} LIMIT ${COUNT_CAP + 1})`).get(...params).n;
      return { total: Math.min(total, COUNT_CAP), capped: total > COUNT_CAP, rows };
    },

    listSessions({ source, project, limit = 50, offset = 0 } = {}) {
      const where = [];
      const params = [];
      if (source) { where.push('source = ?'); params.push(source); }
      if (project) { where.push('project = ?'); params.push(project); }
      const filter = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = db.prepare(`SELECT id, source, project, title, started_at, ended_at, n_messages, n_prompts FROM sessions ${filter}
        ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ? OFFSET ?`).all(...params, Math.min(Number(limit) || 50, 200), Number(offset) || 0);
      const total = db.prepare(`SELECT COUNT(*) AS n FROM sessions ${filter}`).get(...params).n;
      return { total, rows };
    },

    getSession(id) {
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
      if (!session) return null;
      const messages = db.prepare('SELECT seq, role, kind, text, ts FROM messages WHERE session_id = ? ORDER BY seq').all(id);
      const starred = new Set(db.prepare('SELECT seq FROM stars WHERE session_id = ?').all(id).map((r) => r.seq));
      for (const m of messages) m.starred = starred.has(m.seq);
      return { ...session, messages };
    },

    star(sessionId, seq) {
      const row = db.prepare(`SELECT m.text, m.ts, s.source, s.project, s.title FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE m.session_id = ? AND m.seq = ?`).get(sessionId, seq);
      if (!row) return false;
      // The text is copied so a starred prompt survives re-indexing or a deleted source file.
      db.prepare(`INSERT OR REPLACE INTO stars(session_id, seq, text, source, project, session_title, ts, starred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sessionId, seq, row.text, row.source, row.project, row.title, row.ts, Date.now());
      return true;
    },
    unstar(sessionId, seq) { db.prepare('DELETE FROM stars WHERE session_id = ? AND seq = ?').run(sessionId, seq); },
    listStars() { return db.prepare('SELECT * FROM stars ORDER BY starred_at DESC').all(); },

    close() { db.close(); },
  };
  return store;
}

// Deletes the database and everything PromptVault stored (copies of imported files).
export function wipeDataDir(dbPath, dataDir) {
  const removed = [];
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm', dbPath + '-journal']) {
    if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed.push(f); }
  }
  const imports = path.join(dataDir, 'imports');
  if (fs.existsSync(imports)) { fs.rmSync(imports, { recursive: true, force: true }); removed.push(imports); }
  return removed;
}
