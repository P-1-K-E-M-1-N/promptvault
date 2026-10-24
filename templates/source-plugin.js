// TEMPLATE: copy to src/sources/<your-source>.js, then register it in src/sources/index.js.
// Rename every "my-source" below. Delete what you don't need.
//
// A source plugin is one file with:
//   id, name, type      'local' = files already on disk (auto-detected),
//                       'export' = something the person downloads and imports
//   detect(opts)        → array of absolute file paths found on this machine ([] for exports)
//   matches(name, head) → true if this plugin can parse a file (head = first 64 KB as text)
//   parse(input)        → async generator yielding normalized sessions
//   watchRoots(opts)    → optional: folders to watch in --watch mode (local sources)
//
// Normalized session:
//   { id, source, project, title, started_at,
//     messages: [{ role, text, kind, ts }] }
//   kind: 'user_prompt' | 'assistant_reply' | 'tool_call' | 'tool_result'
//   ts / started_at: milliseconds since 1970 (use toMs() for ISO strings or seconds)
//
// Rules: never make network calls, never write to the source files, stream big files.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { truncate, firstLine, toMs } from '../util/text.js';
// For one big JSON array: import { streamJsonArray } from '../util/json-stream.js';

export default {
  id: 'my-source',
  name: 'My Source',
  type: 'local',

  async detect() {
    const dir = path.join(os.homedir(), '.my-source', 'sessions');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
  },

  watchRoots() {
    return [path.join(os.homedir(), '.my-source', 'sessions')];
  },

  matches(name, head) {
    return name.endsWith('.jsonl') && head.includes('"my_source_marker"');
  },

  async *parse(input) {
    // input = { path, name, open() } — open() returns a readable stream,
    // which works the same for a plain file or an entry inside a zip.
    const rl = readline.createInterface({ input: await input.open(), crlfDelay: Infinity });
    const messages = [];
    let id = null;
    let project = null;
    for await (const line of rl) {
      let o;
      try { o = JSON.parse(line); } catch { continue; } // skip half-written lines
      id ??= o.session_id;
      project ??= o.cwd ?? null;
      if (o.role === 'user') messages.push({ role: 'user', kind: 'user_prompt', text: o.text, ts: toMs(o.time) });
      else if (o.role === 'assistant') messages.push({ role: 'assistant', kind: 'assistant_reply', text: o.text, ts: toMs(o.time) });
      else if (o.role === 'tool') messages.push({ role: 'tool', kind: 'tool_result', text: truncate(o.output, 8000), ts: toMs(o.time) });
    }
    if (!messages.length) return;
    yield {
      id: `my-source:${id ?? input.name}`, // must be stable across re-indexing
      source: 'my-source',
      project,
      title: firstLine(messages.find((m) => m.kind === 'user_prompt')?.text) || 'Untitled',
      started_at: messages[0].ts,
      messages,
    };
  },
};
