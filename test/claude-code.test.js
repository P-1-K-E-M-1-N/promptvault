import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../src/sources/claude-code.js';
import { fixture, fileInput, collect } from './helpers.js';

const MAIN = fixture('claude-code', 'projects', 'C--dev-acme-api', '0b9c2a4e-1111-4c1d-9a51-6f0f3c2a0001.jsonl');
const SUB = fixture('claude-code', 'projects', 'C--dev-acme-api', '0b9c2a4e-1111-4c1d-9a51-6f0f3c2a0001', 'subagents', 'agent-a77explore01.jsonl');
const BLOG = fixture('claude-code', 'projects', '-home-sam-blog', '7d1e5f00-2222-4e2a-8b3c-1c2d3e4f0002.jsonl');

test('detect() finds main and subagent transcripts under --claude-dir', async () => {
  const files = await plugin.detect({ claudeDir: fixture('claude-code') });
  assert.equal(files.length, 3);
});

test('main session: title, project, and message kinds', async () => {
  const [s] = await collect(plugin.parse(fileInput(MAIN)));
  assert.equal(s.id, 'claude-code:0b9c2a4e-1111-4c1d-9a51-6f0f3c2a0001');
  assert.equal(s.source, 'claude-code');
  assert.equal(s.title, 'Fix flaky payments retry test', 'custom title wins over ai title');
  assert.equal(s.project, 'C:\\dev\\acme-api');
  assert.equal(s.started_at, Date.parse('2026-03-02T10:00:00.000Z'));

  const prompts = s.messages.filter((m) => m.kind === 'user_prompt').map((m) => m.text);
  assert.deepEqual(prompts, [
    'Fix the flaky retry test in payments. It fails about 1 in 5 runs with ECONNRESET.',
    '/review focus on payments',
    'Now write a regression test so this never comes back.',
  ], 'slash command is rebuilt, system reminder stripped, duplicate uuid ignored');

  const kinds = s.messages.map((m) => m.kind);
  assert.deepEqual(kinds, [
    'user_prompt', 'assistant_reply', 'tool_call', 'tool_result', 'tool_call', 'tool_result',
    'assistant_reply', 'user_prompt', 'tool_result', 'tool_result', 'user_prompt',
  ]);
  assert.match(s.messages[2].text, /^Bash: npm test/);
  assert.match(s.messages[3].text, /ECONNRESET/);
  assert.ok(!s.messages.some((m) => /API Error/.test(m.text)), 'API error placeholder skipped');
  assert.ok(!s.messages.some((m) => /Caveat/.test(m.text)), 'meta caveat skipped');
  const notification = s.messages.find((m) => /task-notification/.test(m.text));
  assert.equal(notification.role, 'system');
  assert.equal(notification.kind, 'tool_result', 'harness notifications are not user prompts');
});

test('subagent transcript: own session, parent project, no user prompts', async () => {
  const [s] = await collect(plugin.parse(fileInput(SUB)));
  assert.equal(s.id, 'claude-code:0b9c2a4e-1111-4c1d-9a51-6f0f3c2a0001:agent-a77explore01');
  assert.equal(s.project, 'C:\\dev\\acme-api', 'worktree path folded into the repo');
  assert.match(s.title, /^Subagent: Search the repo/);
  assert.equal(s.messages.filter((m) => m.kind === 'user_prompt').length, 0);
  assert.equal(s.messages[0].role, 'agent');
});

test('older format with summary entry and POSIX cwd', async () => {
  const [s] = await collect(plugin.parse(fileInput(BLOG)));
  assert.equal(s.title, 'Astro RSS feed generator');
  assert.equal(s.project, '/home/sam/blog');
  assert.equal(s.messages.length, 2);
});

test('matches() recognises a transcript for manual import', async () => {
  const head = (await import('node:fs')).readFileSync(MAIN, 'utf8').slice(0, 4000);
  assert.ok(plugin.matches('x.jsonl', head));
  assert.ok(!plugin.matches('conversations.json', head));
});
