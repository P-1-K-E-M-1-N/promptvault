import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import plugin from '../src/sources/claude-export.js';
import { fixture, fileInput, collect } from './helpers.js';

const FILE = fixture('claude-export', 'conversations.json');

test('parses content blocks, attachments, and skips empty chats', async () => {
  const sessions = await collect(plugin.parse(fileInput(FILE)));
  assert.equal(sessions.length, 2, 'the empty conversation is skipped');
  const [s] = sessions;
  assert.equal(s.id, 'claude-export:c0ffee00-0000-4000-8000-0000000000a1');
  assert.equal(s.title, 'Cover letter for a data role');
  assert.deepEqual(s.messages.map((m) => m.kind), ['user_prompt', 'tool_result', 'tool_call', 'tool_result', 'assistant_reply']);
  assert.match(s.messages[1].text, /\[attachment: resume.txt\]/);
  assert.ok(!s.messages.some((m) => m.text.includes('The user wants a short letter')), 'thinking skipped');
});

test('falls back to the text field and first prompt for a title', async () => {
  const [, s] = await collect(plugin.parse(fileInput(FILE)));
  assert.equal(s.title, "What's a good name for a sourdough starter?");
  assert.deepEqual(s.messages.map((m) => m.text), ["What's a good name for a sourdough starter?", 'Clint Yeastwood.']);
});

test('matches() picks Claude exports and nothing else', () => {
  assert.ok(plugin.matches('conversations.json', fs.readFileSync(FILE, 'utf8')));
  assert.ok(!plugin.matches('conversations.json', fs.readFileSync(fixture('chatgpt', 'conversations.json'), 'utf8')));
});
