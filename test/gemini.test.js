import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import plugin from '../src/sources/gemini-takeout.js';
import { fixture, fileInput, collect } from './helpers.js';

const FILE = fixture('gemini', 'MyActivity.json');

test('groups nearby prompts into one session, oldest first', async () => {
  const sessions = await collect(plugin.parse(fileInput(FILE)));
  assert.equal(sessions.length, 2);
  const [s] = sessions;
  assert.equal(s.source, 'gemini');
  assert.equal(s.title, 'Give me three dinner ideas with chickpeas');
  assert.deepEqual(s.messages.map((m) => m.kind), ['user_prompt', 'assistant_reply', 'user_prompt', 'assistant_reply']);
  assert.equal(s.messages[2].text, 'And now in Spanish please');
  assert.match(s.messages[1].text, /- Chana masala/);
  assert.match(s.messages[1].text, /Enjoy & experiment!/, 'HTML entities decoded');
});

test('ignores non-Gemini records and records without a prompt', async () => {
  const sessions = await collect(plugin.parse(fileInput(FILE)));
  const text = sessions.flatMap((s) => s.messages.map((m) => m.text)).join('\n');
  assert.ok(!text.includes('Searched for chickpeas'));
  assert.ok(!text.includes('Used Gemini Apps'));
  assert.equal(sessions[1].title, 'Explain what a Bloom filter is');
});

test('matches() picks Gemini Takeout files', () => {
  assert.ok(plugin.matches('MyActivity.json', fs.readFileSync(FILE, 'utf8')));
  assert.ok(!plugin.matches('MyActivity.json', '[{"header":"YouTube","title":"Watched"}]'));
});
