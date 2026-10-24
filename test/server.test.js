import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { openStore } from '../src/db.js';
import { indexLocal, createProgress } from '../src/indexer.js';
import { createServer } from '../src/server.js';
import { fixture, tmpDir } from './helpers.js';

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('local server: API works, rejects foreign hosts and header-less writes', async (t) => {
  const dir = tmpDir();
  const store = openStore(path.join(dir, 'index.db'));
  await indexLocal(store, { claudeDir: fixture('claude-code') });
  const ui = createServer({ store, progress: createProgress(), dataDir: dir, version: 'test' });
  const port = await ui.listen(0);
  t.after(() => { ui.server.close(); store.close(); });
  const host = { Host: `127.0.0.1:${port}` };

  const page = await request(port, { headers: host });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);

  const search = await request(port, { path: '/api/search?q=flaky&kinds=user_prompt', headers: host });
  assert.equal(JSON.parse(search.body).total, 1);

  const rebinding = await request(port, { path: '/api/search?q=flaky', headers: { Host: 'evil.example:80' } });
  assert.equal(rebinding.status, 403, 'DNS-rebinding style request refused');

  const body = JSON.stringify({ session_id: 'claude-code:0b9c2a4e-1111-4c1d-9a51-6f0f3c2a0001', seq: 0 });
  const csrf = await request(port, { method: 'POST', path: '/api/stars', headers: { ...host, 'Content-Type': 'text/plain' }, body });
  assert.equal(csrf.status, 403, 'cross-site style POST without header refused');

  const ok = await request(port, { method: 'POST', path: '/api/stars', headers: { ...host, 'X-PromptVault': '1' }, body });
  assert.equal(ok.status, 200);
  const md = await request(port, { path: '/api/export/library', headers: host });
  assert.match(md.body, /flaky retry test/);

  const traversal = await request(port, { path: '/..%2f..%2fpackage.json', headers: host });
  assert.equal(traversal.status, 404);
});
