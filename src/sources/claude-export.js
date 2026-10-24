// Source plugin: Claude.ai official data export (Settings → Privacy → Export data).
// Covers chats from claude.ai, the Claude desktop app, and mobile, which are stored
// in the account rather than on disk. The zip contains conversations.json.

import { streamJsonArray } from '../util/json-stream.js';
import { truncate, firstLine, toMs } from '../util/text.js';

const TOOL_MAX = 8000;

function blockText(b) {
  if (typeof b?.text === 'string') return b.text;
  if (Array.isArray(b?.content)) return b.content.map(blockText).filter(Boolean).join('\n');
  if (typeof b?.content === 'string') return b.content;
  return '';
}

export function convertClaudeConversation(conv) {
  const messages = [];
  for (const m of conv.chat_messages || []) {
    const ts = toMs(m.created_at) ?? toMs(conv.created_at);
    const isUser = m.sender === 'human' || m.sender === 'user';
    const blocks = Array.isArray(m.content) && m.content.length ? m.content : [{ type: 'text', text: m.text }];

    for (const b of blocks) {
      if (b?.type === 'text') {
        const text = (b.text || '').trim();
        if (!text) continue;
        messages.push(isUser
          ? { role: 'user', kind: 'user_prompt', text, ts }
          : { role: 'assistant', kind: 'assistant_reply', text, ts });
      } else if (b?.type === 'tool_use') {
        const text = `${b.name || 'tool'}\n${JSON.stringify(b.input ?? {}, null, 2)}`;
        messages.push({ role: 'assistant', kind: 'tool_call', text: truncate(text, TOOL_MAX), ts });
      } else if (b?.type === 'tool_result') {
        const text = blockText(b).trim();
        if (text) messages.push({ role: 'tool', kind: 'tool_result', text: truncate(text, TOOL_MAX), ts });
      }
      // "thinking" and other block types are skipped.
    }

    for (const a of m.attachments || []) {
      if (a?.extracted_content) {
        messages.push({ role: 'user', kind: 'tool_result', text: truncate(`[attachment: ${a.file_name || 'file'}]\n${a.extracted_content}`, TOOL_MAX), ts });
      }
    }
  }
  if (!messages.length) return null;
  return {
    id: `claude-export:${conv.uuid}`,
    source: 'claude-export',
    project: conv.project?.name || null,
    title: conv.name || firstLine(messages.find((x) => x.kind === 'user_prompt')?.text) || 'Untitled chat',
    started_at: toMs(conv.created_at) ?? messages[0].ts,
    messages,
  };
}

export default {
  id: 'claude-export',
  name: 'Claude.ai / desktop (export)',
  type: 'export',

  async detect() {
    return [];
  },

  matches(name, head) {
    return /\.json$/i.test(name) && head.includes('"chat_messages"');
  },

  async *parse(input) {
    for await (const conv of streamJsonArray(await input.open())) {
      const session = convertClaudeConversation(conv);
      if (session) yield session;
    }
  },
};
