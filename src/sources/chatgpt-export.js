// Source plugin: ChatGPT official data export (Settings → Data controls → Export).
// The zip contains conversations.json: an array of conversations, each holding a
// message *tree* ("mapping"). Edits and regenerations create branches; we follow
// current_node back to the root, which is the branch the person last saw.

import { streamJsonArray } from '../util/json-stream.js';
import { truncate, firstLine, toMs } from '../util/text.js';

const TOOL_MAX = 8000;
const SKIP_TYPES = new Set(['thoughts', 'reasoning_recap', 'user_editable_context', 'model_editable_context', 'system_error']);

function partsText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p?.content_type === 'audio_transcription') return p.text || '';
      if (typeof p?.text === 'string') return p.text;
      return ''; // images, audio pointers, files
    })
    .filter(Boolean)
    .join('\n');
}

function contentText(content) {
  if (!content) return '';
  switch (content.content_type) {
    case 'text':
    case 'multimodal_text':
      return partsText(content.parts);
    case 'code':
    case 'execution_output':
      return content.text || '';
    case 'tether_quote':
      return [content.title, content.url, content.text].filter(Boolean).join('\n');
    case 'tether_browsing_display':
      return content.result || content.summary || '';
    default:
      return content.text || partsText(content.parts);
  }
}

// Walk from the current leaf up to the root, then reverse: the visible thread.
export function currentBranch(conv) {
  const mapping = conv.mapping || {};
  let nodeId = conv.current_node;
  if (!nodeId || !mapping[nodeId]) {
    // No pointer: pick the most recent leaf.
    let best = null;
    for (const [id, n] of Object.entries(mapping)) {
      if (n.children?.length) continue;
      const t = n.message?.create_time ?? 0;
      if (!best || t >= best.t) best = { id, t };
    }
    nodeId = best?.id;
  }
  const chain = [];
  const seen = new Set();
  while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
    seen.add(nodeId);
    chain.push(mapping[nodeId]);
    nodeId = mapping[nodeId].parent;
  }
  return chain.reverse();
}

export function convertConversation(conv) {
  const messages = [];
  for (const node of currentBranch(conv)) {
    const msg = node.message;
    if (!msg || !msg.content) continue;
    if (msg.metadata?.is_visually_hidden_from_conversation) continue;
    if (SKIP_TYPES.has(msg.content.content_type)) continue;
    const role = msg.author?.role;
    if (role === 'system') continue;
    const text = contentText(msg.content).trim();
    if (!text) continue;
    const ts = toMs(msg.create_time) ?? toMs(conv.create_time);

    if (role === 'user') messages.push({ role: 'user', kind: 'user_prompt', text, ts });
    else if (role === 'tool') messages.push({ role: 'tool', kind: 'tool_result', text: truncate(text, TOOL_MAX), ts });
    else if (role === 'assistant') {
      const toTool = msg.recipient && msg.recipient !== 'all';
      if (toTool) messages.push({ role: 'assistant', kind: 'tool_call', text: truncate(`${msg.recipient}: ${text}`, TOOL_MAX), ts });
      else messages.push({ role: 'assistant', kind: 'assistant_reply', text, ts });
    }
  }
  if (!messages.length) return null;
  const id = conv.conversation_id || conv.id || `${conv.create_time}`;
  return {
    id: `chatgpt:${id}`,
    source: 'chatgpt',
    project: null,
    title: conv.title || firstLine(messages.find((m) => m.kind === 'user_prompt')?.text) || 'Untitled chat',
    started_at: toMs(conv.create_time) ?? messages[0].ts,
    messages,
  };
}

export default {
  id: 'chatgpt',
  name: 'ChatGPT (export)',
  type: 'export',

  async detect() {
    return []; // chats live in the account; import the official export instead
  },

  matches(name, head) {
    return /\.json$/i.test(name) && head.includes('"mapping"') && /"(create_time|current_node)"/.test(head);
  },

  async *parse(input) {
    for await (const conv of streamJsonArray(await input.open())) {
      const session = convertConversation(conv);
      if (session) yield session;
    }
  },
};
