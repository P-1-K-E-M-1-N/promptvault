// TEMPLATE: copy to test/<your-source>.test.js. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import plugin from '../src/sources/my-source.js';
import { fixture, fileInput, collect } from './helpers.js';

const FILE = fixture('my-source', 'session.jsonl');

test('parses a session into the normalized schema', async () => {
  const [s] = await collect(plugin.parse(fileInput(FILE)));
  assert.equal(s.source, 'my-source');
  assert.ok(s.id.startsWith('my-source:'));
  assert.equal(s.title, 'Fix the login redirect loop');
  assert.deepEqual(s.messages.map((m) => m.kind), ['user_prompt', 'assistant_reply', 'tool_result']);
});

test('only real human prompts are user_prompt', async () => {
  const [s] = await collect(plugin.parse(fileInput(FILE)));
  // Anything the person didn't type (system text, agent-to-agent messages) must not be user_prompt,
  // or "My prompts only" stops being trustworthy.
  assert.ok(s.messages.filter((m) => m.kind === 'user_prompt').every((m) => !m.text.startsWith('<')));
});

test('matches() accepts this format and rejects others', () => {
  assert.ok(plugin.matches('session.jsonl', fs.readFileSync(FILE, 'utf8')));
  assert.ok(!plugin.matches('session.jsonl', '{"something":"else"}'));
});
