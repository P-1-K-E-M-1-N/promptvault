import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openStore, toFtsQuery } from '../src/db.js';
import { indexLocal, importPath, createProgress } from '../src/indexer.js';
import { sessionToMarkdown, libraryToMarkdown } from '../src/markdown.js';
import { fixture, tmpDir, writeZip } from './helpers.js';

async function freshStore() {
  const dir = tmpDir();
  const store = openStore(path.join(dir, 'index.db'));
  await indexLocal(store, { claudeDir: fixture('claude-code') });
  return { store, dir };
}

test('toFtsQuery never produces invalid FTS5 syntax', () => {
  assert.equal(toFtsQuery('retry test'), '"retry"* "test"*');
  assert.equal(toFtsQuery('"fake timers" ECONNRESET'), '"fake timers" "ECONNRESET"*');
  assert.equal(toFtsQuery('vi.useRealTimers()'), '"vi useRealTimers"');
  assert.equal(toFtsQuery('AND OR NOT ( ) * :'), '"AND"* "OR"* "NOT"*');
  assert.equal(toFtsQuery('   '), '');
});

test('indexes Claude Code and reports sessions across projects', async () => {
  const { store } = await freshStore();
  const t = store.totals();
  const cc = t.bySource.find((s) => s.source === 'claude-code');
  assert.equal(cc.sessions, 3);
  assert.equal(cc.projects, 2);
  assert.equal(t.prompts, 4);
});

test('search finds text, highlights it, and "my prompts only" filters to user turns', async () => {
  const { store } = await freshStore();
  const all = store.search({ q: 'ECONNRESET' });
  assert.ok(all.total >= 2, 'prompt and tool output both match');
  assert.ok(all.rows[0].snippet.includes('\u0001'), 'snippet has highlight markers');

  const mine = store.search({ q: 'ECONNRESET', kinds: ['user_prompt'] });
  assert.equal(mine.total, 1);
  assert.equal(mine.rows[0].kind, 'user_prompt');

  assert.equal(store.search({ q: 'useRealTim' }).total > 0, true, 'prefix matching');
  assert.equal(store.search({ q: 'RSS', project: '/home/sam/blog' }).total, 2, 'prompt + reply in that project');
  assert.equal(store.search({ q: 'RSS', project: 'C:\\dev\\acme-api' }).total, 0);
  assert.equal(store.search({ q: 'RSS', source: 'chatgpt' }).total, 0);
  assert.equal(store.search({ q: 'flaky', to: Date.parse('2026-01-01') }).total, 0, 'date filter');
  assert.equal(store.search({ q: 'flaky', from: Date.parse('2026-03-01'), to: Date.parse('2026-03-03') }).total > 0, true);
  assert.equal(store.search({ q: 'NEAR( "' }).total >= 0, true, 'hostile input does not throw');
});

test('re-index skips unchanged files and replaces changed ones', async () => {
  const { store, dir } = await freshStore();
  const p = createProgress();
  await indexLocal(store, { claudeDir: fixture('claude-code') }, p);
  assert.equal(p.filesSkipped, 3);

  // Copy a transcript, index, then append a prompt (what Claude Code does while you work).
  const proj = path.join(dir, 'cc', 'projects', 'C--x');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 'abc.jsonl');
  const line = (uuid, text) => JSON.stringify({ type: 'user', uuid, sessionId: 'abc', cwd: 'C:\\x', timestamp: '2026-07-01T00:00:00Z', message: { role: 'user', content: text } }) + '\n';
  fs.writeFileSync(file, line('1', 'first zebra prompt'));
  await indexLocal(store, { claudeDir: path.join(dir, 'cc') });
  assert.equal(store.search({ q: 'zebra' }).total, 1);
  fs.appendFileSync(file, line('2', 'second zebra prompt'));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  await indexLocal(store, { claudeDir: path.join(dir, 'cc') });
  assert.equal(store.search({ q: 'zebra' }).total, 2, 'no duplicates after re-index');
});

test('stars survive re-indexing and export to Markdown', async () => {
  const { store } = await freshStore();
  const id = 'claude-code:0b9c2a4e-1111-4c1d-9a51-6f0f3c2a0001';
  assert.ok(store.star(id, 0));
  await indexLocal(store, { claudeDir: fixture('claude-code') }, createProgress());
  const stars = store.listStars();
  assert.equal(stars.length, 1);
  assert.match(stars[0].text, /flaky retry test/);
  const md = libraryToMarkdown(stars);
  assert.match(md, /^# Prompt Library/);
  assert.match(md, /Fix flaky payments retry test/);

  const session = store.getSession(id);
  assert.equal(session.messages[0].starred, true);
  const smd = sessionToMarkdown(session);
  assert.match(smd, /### 🧑 You/);
  assert.match(smd, /<details>/, 'tool calls are collapsed in Markdown too');
  store.unstar(id, 0);
  assert.equal(store.listStars().length, 0);
});

test('imports exports from loose files and from a zip, sniffing the format', async () => {
  const { store, dir } = await freshStore();
  const r1 = await importPath(store, fixture('chatgpt', 'conversations.json'));
  assert.deepEqual(r1.map((r) => [r.source, r.sessions]), [['chatgpt', 2]]);

  const zip = path.join(dir, 'takeout.zip');
  writeZip(zip, {
    'Takeout/My Activity/Gemini Apps/MyActivity.json': fs.readFileSync(fixture('gemini', 'MyActivity.json'), 'utf8'),
    'Takeout/archive_browser.html': '<html></html>',
    'conversations.json': fs.readFileSync(fixture('claude-export', 'conversations.json'), 'utf8'),
  });
  const r2 = await importPath(store, zip);
  assert.deepEqual(r2.map((r) => r.source).sort(), ['claude-export', 'gemini']);
  assert.equal(store.search({ q: 'chickpeas', kinds: ['user_prompt'] }).total, 1);
  assert.equal(store.search({ q: 'sourdough' }).total, 1);

  const again = await importPath(store, zip);
  assert.equal(again.length, 0, 'unchanged zip is not re-imported');
  assert.equal(store.search({ q: 'sourdough' }).total, 1, 'no duplicates');
});
