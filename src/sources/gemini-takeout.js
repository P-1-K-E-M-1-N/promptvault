// Source plugin: Gemini via Google Takeout ("My Activity" → "Gemini Apps", JSON format).
// File: Takeout/My Activity/Gemini Apps/MyActivity.json
//
// Takeout has no conversation IDs: each record is one prompt + one response.
// We group records into sessions when they are less than 30 minutes apart.
// Records are listed newest first, which lets us group while streaming.

import { streamJsonArray } from '../util/json-stream.js';
import { htmlToText, firstLine, toMs } from '../util/text.js';

const GAP_MS = 30 * 60 * 1000;
const PROMPT_PREFIXES = ['Prompted ', 'Asked '];

function isGemini(rec) {
  const products = rec.products || [];
  return /gemini|bard/i.test(rec.header || '') || products.some((p) => /gemini|bard/i.test(p));
}

export function recordToTurn(rec) {
  if (!rec || !isGemini(rec)) return null;
  const ts = toMs(rec.time);
  let prompt = (rec.title || '').trim();
  const prefix = PROMPT_PREFIXES.find((p) => prompt.startsWith(p));
  const responseHtml = (rec.safeHtmlItem || []).map((h) => h?.html || '').join('\n');
  const response = htmlToText(responseHtml);
  // Records like "Used Gemini Apps" or "Created a Gem" carry no prompt.
  if (!prefix && !response) return null;
  if (prefix) prompt = prompt.slice(prefix.length).trim();
  const messages = [];
  if (prompt) messages.push({ role: 'user', kind: 'user_prompt', text: prompt, ts });
  if (response) messages.push({ role: 'assistant', kind: 'assistant_reply', text: response, ts });
  return messages.length ? { ts, messages } : null;
}

function toSession(turnsNewestFirst) {
  const turns = turnsNewestFirst.slice().reverse();
  const messages = turns.flatMap((t) => t.messages);
  const startedAt = turns[0].ts;
  return {
    id: `gemini:${startedAt ?? 'unknown'}`,
    source: 'gemini',
    project: null,
    title: firstLine(messages.find((m) => m.kind === 'user_prompt')?.text) || 'Gemini chat',
    started_at: startedAt,
    messages,
  };
}

export default {
  id: 'gemini',
  name: 'Gemini (Google Takeout)',
  type: 'export',

  async detect() {
    return [];
  },

  matches(name, head) {
    return /\.json$/i.test(name) && /"header"\s*:\s*"(Gemini Apps|Bard)"|"products"\s*:\s*\[[^\]]*"(Gemini Apps|Bard)"/.test(head);
  },

  async *parse(input) {
    let group = [];
    for await (const rec of streamJsonArray(await input.open())) {
      const turn = recordToTurn(rec);
      if (!turn) continue;
      const prev = group[group.length - 1];
      if (prev && (prev.ts == null || turn.ts == null || Math.abs(prev.ts - turn.ts) > GAP_MS)) {
        yield toSession(group);
        group = [];
      }
      group.push(turn);
    }
    if (group.length) yield toSession(group);
  },
};
