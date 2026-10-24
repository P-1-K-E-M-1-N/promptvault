// Markdown export for a single session or the whole Prompt Library.

const SOURCE_NAMES = {
  'claude-code': 'Claude Code',
  chatgpt: 'ChatGPT',
  'claude-export': 'Claude',
  gemini: 'Gemini',
};

export const sourceName = (id) => SOURCE_NAMES[id] || id;

const fmtDate = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown date');

// A code fence longer than any run of backticks inside the text.
function fence(text, lang = '') {
  const longest = Math.max(2, ...(String(text).match(/`+/g) || []).map((s) => s.length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

const LABEL = { user_prompt: 'You', assistant_reply: 'Assistant', tool_call: 'Tool call', tool_result: 'Tool result' };

export function sessionToMarkdown(session) {
  const lines = [`# ${session.title || 'Untitled session'}`, ''];
  lines.push(`- **Source:** ${sourceName(session.source)}`);
  if (session.project) lines.push(`- **Project:** ${session.project}`);
  lines.push(`- **Started:** ${fmtDate(session.started_at)}`);
  lines.push(`- **Messages:** ${session.messages.length}`, '', '---', '');
  for (const m of session.messages) {
    if (m.kind === 'tool_call' || m.kind === 'tool_result') {
      const summary = m.text.split('\n')[0].slice(0, 100).replace(/</g, '&lt;');
      lines.push('<details>', `<summary>${LABEL[m.kind]}: ${summary}</summary>`, '', fence(m.text), '', '</details>', '');
    } else {
      lines.push(`### ${m.kind === 'user_prompt' ? '🧑' : '🤖'} ${LABEL[m.kind]}${m.ts ? ' · ' + fmtDate(m.ts) : ''}`, '', m.text, '');
    }
  }
  return lines.join('\n');
}

export function libraryToMarkdown(stars) {
  const lines = ['# Prompt Library', '', `${stars.length} saved prompt${stars.length === 1 ? '' : 's'}, exported ${fmtDate(Date.now())}.`, ''];
  for (const s of stars) {
    lines.push(`## ${s.session_title || 'Untitled session'}`, '');
    lines.push(`*${[sourceName(s.source), s.project, fmtDate(s.ts)].filter(Boolean).join(' · ')}*`, '');
    lines.push(fence(s.text), '');
  }
  return lines.join('\n');
}
