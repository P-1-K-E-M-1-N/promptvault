# Contributing to PromptVault

Thanks for helping. The project has one job: **every AI session on your machine, in one search box, with nothing leaving the machine.** Contributions that serve that job are very welcome.

## Ground rules

1. **Zero network calls.** No telemetry, no update checks, no remote fonts. `test/no-network.test.js` enforces this.
2. **Zero runtime dependencies.** Node's standard library only (`node:sqlite`, `node:zlib`, streams). This keeps `npx promptvault` fast and the code auditable. Dev tooling is fine if it's truly needed. Ask first.
3. **Read-only on sources.** Never write to, move, or lock someone's AI history files.
4. **Stream, don't slurp.** Some histories are many GB. Read files as streams and yield one session at a time.

## Setup

```sh
git clone https://github.com/YOUR_GITHUB_USERNAME/promptvault
cd promptvault
npm test            # node:test, no install step needed
npm run demo        # opens the UI on the fake fixture data only
```

Requires Node 22.13+.

## How the code is laid out

```
bin/promptvault.js      entry point (Node version check)
src/cli.js              commands and flags
src/indexer.js          runs plugins, validates their output, incremental + progress
src/db.js               SQLite schema, FTS5 search, stars
src/server.js           127.0.0.1-only HTTP server and JSON API
src/watch.js            --watch
src/markdown.js         Markdown export
src/sources/*.js        ← one file per source. Core never knows source details.
src/util/               streaming JSON, zip reader, text helpers
public/                 the web UI (plain HTML/CSS/JS, no build step)
test/                   node:test suites + fixtures/
templates/              starting point for a new source
```

## Add a new source in 30 minutes

Say you want to add **Aider**. Here's the whole job.

### 1. Find the data (5 min)

Where does the tool write sessions? Is it on disk already (a *local* source, auto-detected like Claude Code), or does the user download an export (an *export* source, like ChatGPT)? Look at a real file and note:
- how one session is identified (file per session? an id field?)
- which entries are **the human's prompts**, which are AI replies, and which are tool calls or tool output
- where the timestamp, the project/working directory, and the title live

Write it down in [FORMATS.md](FORMATS.md) in a new section. Future you will thank you.

### 2. Make a tiny fake fixture (5 min)

```sh
mkdir test/fixtures/aider
cp templates/fixture/session.jsonl test/fixtures/aider/   # then rewrite it in Aider's format
```

Write **fake** data by hand. 5–20 lines that cover the tricky cases: a system message that must not count as a prompt, a tool call, a half-written last line, a missing title. **Never commit real conversations**, yours or anyone else's.

### 3. Write the plugin (15 min)

```sh
cp templates/source-plugin.js src/sources/aider.js
```

A plugin is one object:

```js
export default {
  id: 'aider',                 // stable, kebab-case; becomes session.source
  name: 'Aider',
  type: 'local',               // 'local' (on disk) or 'export' (imported by the user)
  async detect(opts) {},       // → absolute paths of files to index ([] for export sources)
  matches(name, head) {},      // → can I parse this file? head = first 64 KB as text
  async *parse(input) {},      // input = { path, name, open() } → yield sessions
  watchRoots(opts) {},         // optional, folders to watch for --watch
};
```

`parse()` yields sessions in the **normalized schema**:

```js
{
  id: 'aider:<stable id>',     // same file → same id, every time
  source: 'aider',
  project: '/home/me/repo',    // or null
  title: 'Short title',
  started_at: 1767225600000,   // ms since epoch (use toMs() from src/util/text.js)
  messages: [
    { role: 'user', kind: 'user_prompt', text: '…', ts: 1767225600000 },
    // kind: 'user_prompt' | 'assistant_reply' | 'tool_call' | 'tool_result'
  ],
}
```

The one rule that matters: **only text the human actually typed gets `kind: 'user_prompt'`.** Injected context, system prompts, agent-to-agent messages, and command output are `tool_call` or `tool_result`. If this is wrong, "My prompts only" stops being trustworthy.

Helpers: `streamJsonArray()` (one huge JSON array, streamed), `readline` (JSONL), `truncate()` (cap tool output at ~8 KB), `htmlToText()`, `firstLine()`, `toMs()`. Zip files are handled by core, so `input.open()` works the same for a loose file or a file inside a zip.

Register it in `src/sources/index.js`:

```js
import aider from './aider.js';
export const sources = [claudeCode, chatgpt, claudeExport, gemini, aider];
```

### 4. Test it (5 min)

```sh
cp templates/source.test.js test/aider.test.js   # point it at your fixture
npm test
node bin/promptvault.js --db ./.demo/aider.db --no-open   # try it on your real data, locally
```

Add a row to the sources table in README.md, then open a PR. 🎉

## Other contributions

- **Bug reports:** use the bug template. Include your OS, Node version, and `promptvault --version`. If a parser fails, a *redacted* snippet showing the shape of the line that broke helps a lot.
- **UI:** keep it plain HTML/CSS/JS with no external assets (the Content-Security-Policy will block them anyway).
- **Bigger ideas:** check [BACKLOG.md](BACKLOG.md) first and open an issue before building.

## Releasing (maintainers)

`npm test` must pass on Windows, macOS, and Linux (CI matrix in `.github/workflows/ci.yml`). Bump `version` in `package.json`, tag, then `npm publish`.
