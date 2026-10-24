import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import plugin from '../src/sources/chatgpt-export.js';
import { fixture, fileInput, collect } from './helpers.js';

const FILE = fixture('chatgpt', 'conversations.json');

test('follows current_node: edited and regenerated branches are dropped', async () => {
  const sessions = await collect(plugin.parse(fileInput(FILE)));
  assert.equal(sessions.length, 2);
  const [s] = sessions;
  assert.equal(s.id, 'chatgpt:6795a1b2-0000-4000-8000-0000000000c1');
  assert.equal(s.title, 'Regex for UK postcodes');
  assert.equal(s.started_at, 1767225600123);
  const all = s.messages.map((m) => m.text).join('\n');
  assert.ok(!all.includes('DISCARDED'), 'regenerated answer dropped');
  assert.ok(!all.includes('EDITED AWAY'), 'edited prompt dropped');
  assert.ok(!all.includes('secret reasoning'), 'thoughts dropped');
  assert.ok(!all.includes('Be terse'), 'custom instructions dropped');
  assert.deepEqual(s.messages.map((m) => m.kind), ['user_prompt', 'assistant_reply', 'user_prompt', 'tool_call', 'tool_result', 'assistant_reply']);
  assert.match(s.messages[3].text, /^python: import re/);
});

test('multimodal prompt keeps the text and skips the image', async () => {
  const [, s] = await collect(plugin.parse(fileInput(FILE)));
  assert.equal(s.messages[0].text, 'Write three captions for this sunset photo');
  assert.equal(s.started_at, 1769904000000);
});

test('matches() picks ChatGPT exports and nothing else', () => {
  const head = fs.readFileSync(FILE, 'utf8').slice(0, 65536);
  assert.ok(plugin.matches('conversations.json', head));
  assert.ok(!plugin.matches('conversations.json', fs.readFileSync(fixture('claude-export', 'conversations.json'), 'utf8')));
});
