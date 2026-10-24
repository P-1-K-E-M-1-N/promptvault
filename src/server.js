// The local web UI and its JSON API. Binds to 127.0.0.1 only.
// This module only *listens*; PromptVault never opens an outgoing connection.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { sessionToMarkdown, libraryToMarkdown } from './markdown.js';
import { importPath } from './indexer.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const MAX_UPLOAD = 8 * 1024 * 1024 * 1024; // 8 GB

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  // The page may only talk to this server: no external scripts, fonts, images or requests.
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(data);
}

async function readJson(req, limit = 1e6) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Body too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function safeFilename(name) {
  return (String(name || 'export').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'export').trim();
}

export function createServer(ctx) {
  const { store, progress, dataDir } = ctx;
  let allowedHosts = new Set();

  const server = http.createServer(async (req, res) => {
    try {
      // Block DNS-rebinding: only answer requests addressed to this machine.
      if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) return send(res, 403, { error: 'Forbidden host' });

      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;

      // Every state-changing request must carry this header. Browsers will not let
      // another website add it without a CORS preflight, which we never approve.
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-promptvault'] !== '1') {
        return send(res, 403, { error: 'Missing X-PromptVault header' });
      }

      if (p.startsWith('/api/')) return await api(req, res, url);

      // Static files.
      const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
      const file = path.join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      }
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });

  async function api(req, res, url) {
    const p = url.pathname;
    const g = (k) => url.searchParams.get(k) || undefined;

    if (p === '/api/status' && req.method === 'GET') {
      return send(res, 200, {
        progress, totals: store.totals(), watch: !!ctx.watch, dataDir, dbPath: store.path,
        lastChange: ctx.lastChange || null, firstRunSummary: ctx.firstRunSummary || null, version: ctx.version,
      });
    }
    if (p === '/api/facets') return send(res, 200, store.facets());
    if (p === '/api/search') {
      const kinds = (g('kinds') || '').split(',').filter(Boolean);
      return send(res, 200, store.search({
        q: g('q'), kinds, source: g('source'), project: g('project'),
        from: g('from'), to: g('to'), sort: g('sort'), limit: g('limit'), offset: g('offset'),
      }));
    }
    if (p === '/api/sessions') {
      return send(res, 200, store.listSessions({ source: g('source'), project: g('project'), limit: g('limit'), offset: g('offset') }));
    }
    if (p === '/api/session') {
      const s = store.getSession(g('id'));
      return s ? send(res, 200, s) : send(res, 404, { error: 'Session not found' });
    }
    if (p === '/api/stars' && req.method === 'GET') return send(res, 200, store.listStars());
    if (p === '/api/stars' && req.method === 'POST') {
      const { session_id, seq, starred } = await readJson(req);
      if (starred === false) store.unstar(session_id, Number(seq));
      else if (!store.star(session_id, Number(seq))) return send(res, 404, { error: 'Message not found' });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/export/session') {
      const s = store.getSession(g('id'));
      if (!s) return send(res, 404, { error: 'Session not found' });
      return send(res, 200, sessionToMarkdown(s), 'text/markdown; charset=utf-8', {
        'Content-Disposition': `attachment; filename="${safeFilename(s.title)}.md"`,
      });
    }
    if (p === '/api/export/library') {
      return send(res, 200, libraryToMarkdown(store.listStars()), 'text/markdown; charset=utf-8', {
        'Content-Disposition': 'attachment; filename="prompt-library.md"',
      });
    }
    if (p === '/api/import' && req.method === 'POST') {
      if (progress.running) return send(res, 409, { error: 'Indexing is already running, try again in a moment.' });
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > MAX_UPLOAD) return send(res, 413, { error: 'File too large' });
      // Keep a private copy in the data folder so it can be re-indexed; "wipe" deletes it.
      const dir = path.join(dataDir, 'imports');
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `${Date.now()}-${safeFilename(g('name'))}`);
      await pipeline(req, fs.createWriteStream(dest));
      const results = await importPath(store, dest, progress);
      ctx.lastChange = Date.now();
      if (!results.length) fs.rmSync(dest, { force: true });
      return send(res, 200, { results, errors: progress.errors.slice(-5) });
    }
    if (p === '/api/wipe' && req.method === 'POST') {
      send(res, 200, { ok: true });
      setTimeout(() => ctx.onWipe?.(), 50);
      return;
    }
    return send(res, 404, { error: 'Unknown endpoint' });
  }

  return {
    server,
    listen(port) {
      return new Promise((resolve, reject) => {
        const tryPort = (n, attempts) => {
          server.once('error', (err) => {
            if (err.code === 'EADDRINUSE' && attempts > 0) tryPort(n + 1, attempts - 1);
            else reject(err);
          });
          server.listen(n, '127.0.0.1', () => {
            const actual = server.address().port;
            allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
            resolve(actual);
          });
        };
        tryPort(port, 20);
      });
    },
  };
}
