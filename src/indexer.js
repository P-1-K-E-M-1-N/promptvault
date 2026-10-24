// The indexer runs source plugins and writes their sessions to the store.
// It knows nothing about any particular source: it only calls detect(),
// matches() and parse(), and validates what comes back.

import fs from 'node:fs';
import path from 'node:path';
import { sources, KINDS } from './sources/index.js';
import { isZip, listZip, openZipEntry } from './util/zip.js';
import { readHead } from './util/text.js';

const BATCH = 200; // sessions per transaction before yielding to the event loop
const SLICE = 1000; // messages per transaction for one very large session
const tick = () => new Promise((r) => setImmediate(r));

export function createProgress() {
  return {
    running: false, phase: 'idle', filesTotal: 0, filesDone: 0, filesSkipped: 0,
    sessions: 0, current: null, errors: [], startedAt: null, finishedAt: null,
  };
}

// Make sure plugin output matches the normalized schema, whatever the plugin did.
export function normalizeSession(s, plugin) {
  if (!s || typeof s !== 'object') throw new Error(`${plugin.id}: parse() yielded a non-object`);
  if (!s.id) throw new Error(`${plugin.id}: session is missing an id`);
  const messages = (Array.isArray(s.messages) ? s.messages : [])
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({
      role: String(m.role || 'unknown'),
      kind: KINDS.includes(m.kind) ? m.kind : 'assistant_reply',
      text: m.text,
      ts: Number.isFinite(m.ts) ? m.ts : null,
    }));
  return {
    id: String(s.id),
    source: s.source || plugin.id,
    project: s.project ? String(s.project) : null,
    title: s.title ? String(s.title).slice(0, 300) : 'Untitled',
    started_at: Number.isFinite(s.started_at) ? s.started_at : messages.find((m) => m.ts)?.ts ?? null,
    messages,
  };
}

async function runParse(store, plugin, input, key, progress) {
  progress.current = input.name;
  let pending = [];
  let count = 0;
  const flush = () => {
    const batch = pending;
    pending = [];
    store.transaction(() => { for (const s of batch) store.insertSession(s, key); });
  };
  // Replace whatever this file produced before.
  store.transaction(() => store.removeSessionsForFile(key));
  for await (const raw of plugin.parse(input)) {
    const s = normalizeSession(raw, plugin);
    if (!s.messages.length) continue;
    if (s.messages.length > SLICE) {
      // One giant session (a days-long agent run): write it in slices so the UI stays responsive.
      if (pending.length) flush();
      for (let from = 0; from < s.messages.length; from += SLICE) {
        const to = Math.min(from + SLICE, s.messages.length);
        store.transaction(() => store.insertMessages(s, from, to));
        await tick();
      }
      store.transaction(() => store.finishSession(s, key));
      count++;
      progress.sessions++;
      continue;
    }
    pending.push(s);
    count++;
    progress.sessions++;
    if (pending.length >= BATCH) { flush(); await tick(); }
  }
  if (pending.length) flush();
  return count;
}

function fileInput(filePath) {
  return { path: filePath, name: path.basename(filePath), open: async () => fs.createReadStream(filePath) };
}

// Index one local file for a plugin, skipping it if size+mtime are unchanged.
export async function indexFile(store, plugin, filePath, progress = createProgress(), { force = false } = {}) {
  let st;
  try { st = fs.statSync(filePath); } catch { return 0; }
  const mtime = Math.floor(st.mtimeMs);
  if (!force && store.fileUnchanged(filePath, st.size, mtime)) { progress.filesSkipped++; return 0; }
  try {
    const n = await runParse(store, plugin, fileInput(filePath), filePath, progress);
    store.markFile(filePath, plugin.id, st.size, mtime);
    return n;
  } catch (err) {
    progress.errors.push(`${filePath}: ${err.message}`);
    return 0;
  }
}

// Auto-discover and index every local source (Claude Code, ...).
export async function indexLocal(store, opts = {}, progress = createProgress(), onTick) {
  progress.running = true;
  progress.phase = 'scanning';
  progress.startedAt = Date.now();
  try {
    const work = [];
    for (const plugin of sources.filter((s) => s.type === 'local')) {
      const files = await plugin.detect(opts);
      for (const f of files) work.push({ plugin, file: f });
    }
    progress.filesTotal += work.length;
    progress.phase = 'indexing';
    for (const { plugin, file } of work) {
      await indexFile(store, plugin, file, progress);
      progress.filesDone++;
      onTick?.(progress);
      await tick();
    }
  } finally {
    progress.phase = 'done';
    progress.running = false;
    progress.current = null;
    progress.finishedAt = Date.now();
  }
  return progress;
}

async function pickPlugin(name, open) {
  const candidates = sources.filter((s) => typeof s.matches === 'function');
  if (!candidates.length) return null;
  const head = await readHead(await open());
  return candidates.find((s) => s.matches(name, head)) || null;
}

function walkFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// Import an export: a .json/.jsonl file, a folder (e.g. an unzipped Takeout), or a .zip.
// Returns a list of { name, source, sessions } describing what was imported.
export async function importPath(store, target, progress = createProgress()) {
  const results = [];
  const abs = path.resolve(target);
  const st = fs.statSync(abs);
  progress.running = true;
  progress.phase = 'importing';
  try {
    const files = st.isDirectory() ? walkFiles(abs) : [abs];
    progress.filesTotal += files.length;
    for (const file of files) {
      if (await isZip(file).catch(() => false)) {
        const fst = fs.statSync(file);
        for (const entry of await listZip(file)) {
          const open = () => openZipEntry(file, entry);
          const key = `${file}!${entry.name}`;
          if (store.fileUnchanged(key, entry.size, Math.floor(fst.mtimeMs))) continue;
          const plugin = await pickPlugin(path.basename(entry.name), open).catch(() => null);
          if (!plugin) continue;
          try {
            const n = await runParse(store, plugin, { path: key, name: entry.name, open }, key, progress);
            store.markFile(key, plugin.id, entry.size, Math.floor(fst.mtimeMs));
            results.push({ name: `${path.basename(file)} → ${entry.name}`, source: plugin.id, sessions: n });
          } catch (err) {
            progress.errors.push(`${key}: ${err.message}`);
          }
        }
      } else {
        const plugin = await pickPlugin(path.basename(file), async () => fs.createReadStream(file)).catch(() => null);
        if (plugin) {
          const n = await indexFile(store, plugin, file, progress, { force: true });
          results.push({ name: path.basename(file), source: plugin.id, sessions: n });
        }
      }
      progress.filesDone++;
    }
  } finally {
    progress.running = false;
    progress.phase = 'done';
    progress.current = null;
    progress.finishedAt = Date.now();
  }
  return results;
}
