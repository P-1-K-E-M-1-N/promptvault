# Launch plan

## Before launch: checklist

- [ ] Pick the final name (DECISIONS.md → Name), then rename in `package.json`, README, `public/index.html`.
- [ ] Replace `YOUR_NAME` / `YOUR_GITHUB_USERNAME` in `package.json`, `LICENSE`, `.github/FUNDING.yml`, `public/index.html`, README, CONTRIBUTING.
- [ ] **Test the three export parsers on real exports.** Request your own ChatGPT, Claude.ai, and Gemini (Takeout, JSON) exports and import them. They were built from documentation and hand-made fixtures only. Fix any field-name drift *before* the HN post, because "it didn't import my export" will be the top comment otherwise.
- [ ] Run `npm test` on macOS and Linux (CI does this once the repo is on GitHub). Only Windows was tested locally.
- [ ] Record `docs/hero.gif` (below) and swap it into the README.
- [ ] Turn on GitHub Sponsors for the account.
- [ ] Create the public repo, push, and confirm CI is green on all three OSes.
- [ ] `npm publish` (check `npm pack --dry-run` first: only `bin/ src/ public/ README.md LICENSE` should ship).
- [ ] Try `npx <name>` on a clean machine.

### Recording the hero GIF

Use the fixture data so no real prompts appear: `npm run demo`. Show three steps in about 10 seconds: (1) type `retry`, results across Claude Code / ChatGPT / Gemini; (2) flip **My prompts only**; (3) open a session, expand tool steps, click **Copy**. Keep it under 3 MB at 1200×700. Tools: ScreenToGif (Windows) or Kap (macOS).

## Launch week

Same week, in this order: **Show HN (Tue/Wed, ~8–9am US Eastern)** → r/ClaudeAI → r/ChatGPTCoding → Claude Code Discords. Reply to every comment for the first 6 hours. Bugs reported in threads get fixed and released the same day if possible.

### Show HN

**Title:** Show HN: PromptVault – search every prompt you've sent to Claude Code, ChatGPT and Gemini, locally

> I switch between Claude Code, ChatGPT and Gemini all day, and I kept losing the prompts that worked. Claude Code alone had put thousands of sessions in ~/.claude/projects, and none of the vendors search across tools.
>
> PromptVault is `npx promptvault`. It finds your Claude Code history on disk with no export needed, indexes it in SQLite FTS5, and opens a search page on 127.0.0.1. ChatGPT, Claude.ai and Gemini go in through their official exports (drag the zip in).
>
> The feature I use most is a "My prompts only" switch. Harder than it sounds: in Claude Code's JSONL, only ~5% of "user" entries are things a human typed. The rest are tool results, agent-to-agent messages and injected reminders.
>
> Privacy: zero network calls and zero npm dependencies (Node's built-in sqlite, a hand-rolled zip reader), so the whole thing is ~2.3k lines you can audit. The README has a "verify it yourself" section. MIT, free, no paid tier.
>
> Each source is one plugin file (detect + parse). Codex CLI and Cursor are documented but not built yet. I'd love PRs. What should it support next?

### r/ClaudeAI

**Title:** I built a free, local search for all your Claude Code sessions (+ ChatGPT/Gemini/Claude.ai exports)

> Claude Code writes every session to `~/.claude/projects` as JSONL, and after a few months that's thousands of sessions you can't search. I made `npx promptvault`: it indexes them locally and opens a search page with a **My prompts only** switch, filters by project/repo and date, a clean reader with tool calls collapsed, a copy button on every prompt, and a starred "Prompt Library" you can export to Markdown.
>
> - Works with the CLI, IDE extensions and the desktop app's Code tab (same files)
> - Subagent transcripts included, and they don't pollute your prompts
> - `--watch` keeps it up to date while you work
> - Nothing leaves your machine. No network calls at all, MIT, no dependencies
>
> Claude.ai/desktop chats aren't stored locally, so those come in through Settings → Privacy → Export data.
>
> Feedback very welcome, especially if your history is huge. [link]

### r/ChatGPTCoding

**Title:** Free local tool: one search box across Claude Code, ChatGPT, Claude.ai and Gemini history

> If you bounce between tools, your best prompts are scattered across four products, and none of them search each other. `npx promptvault` indexes Claude Code straight from disk and imports the official ChatGPT / Claude / Gemini exports (drag the zip in). Full-text search with highlighted snippets, filters by tool/project/date, and a "My prompts only" switch to find the prompt you wrote, not the 2,000-line reply.
>
> 100% local (SQLite on your machine, zero network calls, you can verify), MIT, no account. Codex CLI and Cursor support are next. Plugins are one file each if you want to help. [link]

### Claude Code Discords (short)

> Made a thing: `npx promptvault` turns `~/.claude/projects` into a local search page. Search every session, "my prompts only" toggle, star prompts into a library, `--watch` mode. Zero network calls, MIT. Would love feedback from people with big histories 🙏 [link]

## Success criteria (month one)

| Signal | Bar | What it means |
|---|---|---|
| GitHub stars | **500+** | People want this |
| npm weekly downloads | **1,000+** | People actually run it, repeatedly |
| **Outside contributors adding source plugins** | ≥ 1 merged | **Strongest signal.** The plugin design works and the community wants coverage |
| Issues "my export didn't import" | trending to 0 | Parsers are robust |

**If it hits:** build the MCP server next (BACKLOG.md → top v2 candidate), so agents can search your past sessions themselves.

**If it misses** (under ~150 stars, few repeat downloads): ask the people who *did* use it what they searched for, then decide between fixing positioning and stopping. Don't add features to rescue it.
