// Source plugin: Claude Code (CLI, IDE extensions, and the desktop app's Code tab).
// Reads ~/.claude/projects/<project>/<sessionId>.jsonl plus subagent transcripts
// at <project>/<sessionId>/subagents/agent-<id>.jsonl. See FORMATS.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { truncate, firstLine, toMs } from '../util/text.js';

const TOOL_CALL_MAX = 4000;
const TOOL_RESULT_MAX = 8000;

export function claudeRoots(opts = {}) {
  if (opts.claudeDir) {
    const dir = path.resolve(opts.claudeDir);
    const projects = path.join(dir, 'projects');
    return [fs.existsSync(projects) ? projects : dir];
  }
  const roots = [];
  if (process.env.CLAUDE_CONFIG_DIR) roots.push(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'));
  roots.push(path.join(os.homedir(), '.claude', 'projects'));
  // De-duplicate (also across symlinks/junctions pointing at the same folder).
  const seen = new Set();
  return roots.filter((r) => {
    let key = r;
    try { key = fs.realpathSync(r); } catch { return false; }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function listJsonl(dir, depth = 0, out = []) {
  if (depth > 4) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJsonl(p, depth + 1, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// "C--Users-me-code-app" → best-effort path, used only when no cwd was recorded.
function decodeProjectDir(name) {
  if (/^[A-Za-z]--/.test(name)) return name[0] + ':\\' + name.slice(3).replace(/-/g, '\\');
  return name.replace(/-/g, '/');
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

function toolCallText(block) {
  const input = block.input ?? {};
  const name = block.name || 'tool';
  // Show the most human-meaningful field first, then the raw input.
  const lead = input.command ?? input.description ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? '';
  const json = JSON.stringify(input, null, 2);
  return truncate(`${name}${lead ? ': ' + String(lead).split('\n')[0] : ''}\n${json}`, TOOL_CALL_MAX);
}

const SKIP_PREFIXES = ['<local-command-caveat>', 'Caveat: The messages below were generated', '[Request interrupted by user'];

// Classify one piece of text from a "user" entry. Returns null to skip it.
export function classifyUserText(raw, entry) {
  let text = String(raw ?? '');
  // Remove harness-injected reminders; they are not something the person typed.
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text) return null;
  if (SKIP_PREFIXES.some((p) => text.startsWith(p))) return null;

  const originKind = entry.origin?.kind;
  if ((originKind && originKind !== 'human') || text.startsWith('<task-notification>')) {
    return { role: 'system', kind: 'tool_result', text: truncate(text, TOOL_RESULT_MAX) };
  }
  if (/^<local-command-std(out|err)>/.test(text)) {
    const inner = text.replace(/<\/?local-command-std(out|err)>/g, '').trim();
    return inner ? { role: 'tool', kind: 'tool_result', text: truncate(inner, TOOL_RESULT_MAX) } : null;
  }
  const cmd = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    text = `${cmd[1].trim()}${args ? ' ' + args : ''}`;
  }
  // Keep pasted text but drop the wrapper tags.
  text = text.replace(/<\/?pasted_content[^>]*>/g, '').trim();
  if (!text) return null;

  // In a subagent transcript the "user" is the parent agent, not the person.
  if (entry.isSidechain) return { role: 'agent', kind: 'tool_call', text: truncate(text, TOOL_CALL_MAX) };
  return { role: 'user', kind: 'user_prompt', text };
}

export async function* parseClaudeCodeStream(stream, filePath = '') {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const messages = [];
  let sessionId = null;
  let agentId = null;
  let cwd = null;
  let customTitle = null;
  let aiTitle = null;
  let agentName = null;
  let sidechain = false;
  let startedAt = null;
  const seenUuids = new Set();

  for await (const line of rl) {
    if (!line || line.charCodeAt(0) !== 123) continue; // must start with "{"
    let o;
    try { o = JSON.parse(line); } catch { continue; } // tolerate a half-written last line
    if (o.sessionId && !sessionId) sessionId = o.sessionId;

    switch (o.type) {
      case 'custom-title': customTitle = o.customTitle || customTitle; continue;
      case 'ai-title': aiTitle = o.aiTitle || aiTitle; continue;
      case 'agent-name': agentName = o.agentName || agentName; continue;
      case 'summary': if (!aiTitle && o.summary) aiTitle = o.summary; continue; // older versions
      case 'user':
      case 'assistant':
        break;
      default:
        continue; // attachments, snapshots, api-request logs, cost-state, etc.
    }

    if (o.uuid) {
      if (seenUuids.has(o.uuid)) continue;
      seenUuids.add(o.uuid);
    }
    if (o.isSidechain) sidechain = true;
    if (o.agentId && !agentId) agentId = o.agentId;
    if (o.cwd && !cwd) cwd = o.cwd;
    const ts = toMs(o.timestamp);
    if (ts && (!startedAt || ts < startedAt)) startedAt = ts;

    if (o.type === 'user') {
      if (o.isMeta) continue;
      const content = o.message?.content;
      if (typeof content === 'string') {
        const m = classifyUserText(content, o);
        if (m) messages.push({ ...m, ts });
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'text') {
            const m = classifyUserText(b.text, o);
            if (m) messages.push({ ...m, ts });
          } else if (b?.type === 'tool_result') {
            const text = toolResultText(b.content);
            if (text) messages.push({ role: 'tool', kind: 'tool_result', text: truncate(text, TOOL_RESULT_MAX), ts });
          }
        }
      }
    } else {
      if (o.isApiErrorMessage) continue;
      const content = o.message?.content;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (b?.type === 'text' && b.text?.trim()) {
          messages.push({ role: 'assistant', kind: 'assistant_reply', text: b.text, ts });
        } else if (b?.type === 'tool_use') {
          messages.push({ role: 'assistant', kind: 'tool_call', text: toolCallText(b), ts });
        }
        // "thinking" blocks are skipped: usually empty/redacted on disk and noisy to search.
      }
    }
  }

  if (!sessionId) sessionId = path.basename(filePath, '.jsonl');
  if (!messages.length) return;

  const base = path.basename(filePath, '.jsonl');
  const isSubagent = sidechain || base.startsWith('agent-');
  const parentId = isSubagent ? path.basename(path.dirname(path.dirname(filePath))) || sessionId : sessionId;
  const firstAsk = messages.find((m) => m.kind === 'user_prompt' || (isSubagent && m.kind === 'tool_call'));
  let title = customTitle || aiTitle || agentName || firstLine(firstAsk?.text) || 'Untitled session';
  if (isSubagent) title = `Subagent: ${agentName || firstLine(firstAsk?.text, 70) || title}`;

  const projectDir = path.basename(isSubagent ? path.dirname(path.dirname(path.dirname(filePath))) : path.dirname(filePath));

  // Agents working in a git worktree (<repo>/.claude/worktrees/<name>) belong to <repo>.
  if (cwd) cwd = cwd.replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+.*$/, '');

  yield {
    id: isSubagent ? `claude-code:${parentId}:agent-${agentId || base.replace(/^agent-/, '')}` : `claude-code:${sessionId}`,
    source: 'claude-code',
    project: cwd || (projectDir ? decodeProjectDir(projectDir) : null),
    title,
    started_at: startedAt,
    messages,
  };
}

export default {
  id: 'claude-code',
  name: 'Claude Code',
  type: 'local',

  // Returns every transcript file this source can find on this machine.
  async detect(opts = {}) {
    return claudeRoots(opts).flatMap((root) => listJsonl(root));
  },

  // Folders to watch in --watch mode.
  watchRoots(opts = {}) {
    return claudeRoots(opts);
  },

  // Claude Code transcripts can also be imported by hand (e.g. copied from another machine).
  matches(name, head) {
    return name.endsWith('.jsonl') && /"sessionId"\s*:/.test(head) && /"type"\s*:\s*"(user|assistant|summary|queue-operation)"/.test(head);
  },

  async *parse(input) {
    yield* parseClaudeCodeStream(await input.open(), input.path || input.name);
  },
};
