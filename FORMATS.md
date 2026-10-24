# Source formats

What each AI tool stores, where, and how PromptVault reads it. Each section says **how it was verified**, because these formats are undocumented and change without notice.

Last researched: **2026-10-24**.

| Source | Where it lives | Status in v1 | Verified against |
|---|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` (on disk) | ✅ Built, auto-detected | Real transcripts: 25 files / 33 MB, Claude Code 2.0.x–2.1.304, Windows |
| Claude desktop app: Code tab | Same files as Claude Code | ✅ Covered by Claude Code | Real desktop app data on Windows |
| Claude.ai / desktop / mobile chats | In your account, not on disk | ✅ Built, via official export | Community docs; **no real export tested** |
| Claude Cowork | Desktop app folder (see below) | ⚠️ Not built | Folder inspected; no transcripts present on the test machine |
| ChatGPT | In your account | ✅ Built, via official export | Community docs + format knowledge; **no real export tested** |
| Gemini | In your Google account | ✅ Built, via Google Takeout | Google's My Activity schema + community docs; **least certain** |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | 📄 Documented only | Third-party docs; not installed on test machine |
| Cursor | `state.vscdb` SQLite files | 📄 Documented only | Third-party docs and forum posts |

---

## Claude Code ✅ (built first)

**Location.** `~/.claude/projects/<encoded-project>/<sessionId>.jsonl`, where `~` is your home folder (`C:\Users\<you>` on Windows). If `CLAUDE_CONFIG_DIR` is set, PromptVault also reads `$CLAUDE_CONFIG_DIR/projects`. The folder name encodes the working directory with separators replaced by `-` (`C:\MrC\app` becomes `C--MrC-app`). That encoding is lossy, so PromptVault uses the `cwd` field inside the file as the project and only falls back to decoding the folder name.

**Subagents.** Transcripts of delegated agents live in `<encoded-project>/<sessionId>/subagents/agent-<agentId>.jsonl`. Every line there has `"isSidechain": true` and an `agentId`. Subagents often run in a git worktree (`<repo>/.claude/worktrees/agent-<id>`), and PromptVault folds that path back into `<repo>`.

**Shape.** One JSON object per line, appended as the session runs. The last line can be half-written while Claude Code is still working, so the parser skips lines that fail to parse. Every line has a `type`. Types seen on real data, with counts from the test machine:

| `type` | What it is | PromptVault |
|---|---|---|
| `user` (1,951) | Human prompts, **and** tool results, **and** harness messages | Classified, see below |
| `assistant` (3,159) | Model output. **One line per content block**: a single API message with thinking + text + 2 tool calls becomes 4 lines sharing `message.id` | Each block is one message |
| `custom-title` | Title the person set (`customTitle`) | Title, highest priority |
| `ai-title` | Auto-generated title (`aiTitle`) | Title, 2nd priority |
| `agent-name` | Name of the session/agent (`agentName`) | Title, 3rd priority |
| `summary` | Older versions' title (`summary`) | Title fallback |
| `last-prompt`, `queue-operation` | Copies of prompt text (queued while busy) | Skipped (duplicates) |
| `attachment` | Injected context (tool lists, file contents, hooks) | Skipped |
| `system` (`subtype`: `api_error`, `turn_duration`, `stop_hook_summary`, `away_summary`, …) | Harness events | Skipped |
| `file-history-snapshot`, `file-history-delta` | Undo checkpoints | Skipped |
| `api-request`, `api-request-shape`, `api-request-blob` | Raw API request logs (newer versions) | Skipped |
| `cost-state`, `mode`, `permission-mode`, `bridge-session`, `atis-latch` | Session state | Skipped |

Common fields on `user`/`assistant` lines: `uuid`, `parentUuid`, `sessionId`, `timestamp` (ISO 8601 UTC), `cwd`, `gitBranch`, `version`, `isSidechain`, `userType`, `entrypoint` (`cli`, `claude-desktop`, …).

**`message.content`** is either a string or an array of blocks:
- `assistant`: `thinking` (on disk the text is usually empty and only a signature remains, so it is skipped), `text`, `tool_use` (`{ id, name, input }`).
- `user`: `text`, `tool_result` (`{ tool_use_id, content: string | [{type:'text'|'image', …}], is_error }`), `image`.

**Telling the person's prompts apart from everything else.** This matters most, because it is what "My prompts only" depends on. A `user` line is **not** something the person typed when:
- `isMeta: true` (skill bodies, local-command caveats) → skipped
- `origin.kind` is anything except `human` (`task-notification`, `peer`, `coordinator`) → stored as `tool_result` with role `system`
- it holds `tool_result` blocks (also flagged by a top-level `toolUseResult`) → `tool_result`
- the text starts with `<task-notification>`, `<local-command-stdout>`, `<local-command-stderr>`, or `<local-command-caveat>` → system/tool output
- it is in a subagent file (`isSidechain`) → the "user" is the parent agent, stored as `tool_call` with role `agent`

Within real prompts, `<system-reminder>…</system-reminder>` blocks are removed (they are injected by the harness). Slash commands arrive as `<command-name>/review</command-name><command-args>…</command-args>` and are rebuilt to `/review …`. Pasted text is wrapped in `<pasted_content …>` tags, which are dropped while the text is kept. Lines with a `uuid` already seen are skipped. On the test machine, 92 of the 1,951 `user` lines were real human prompts.

**Other files in `~/.claude`** (not read): `history.jsonl` (prompt history for the up-arrow key, which duplicates transcripts), `file-history/`, `shell-snapshots/`, `settings.json`, and `.credentials.json` (never read).

## Claude desktop app and Cowork ⚠️

Inspected on Windows (Microsoft Store install). App data is at `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\`. A regular installer uses `%APPDATA%\Claude\`, and macOS uses `~/Library/Application Support/Claude/`.

- **`claude-code-sessions/<account>/<org>/local_<uuid>.json`**: metadata for sessions in the desktop app's *Code* tab (`cliSessionId`, `cwd`, `title`, `model`, timestamps). It contains no transcript. The transcript is the normal Claude Code JSONL in `~/.claude/projects`, with `"entrypoint": "claude-desktop"`, so the Claude Code plugin already covers it.
- **`local-agent-mode-sessions/`** (Cowork): on the test machine this held only `remote-session-spaces.json`, `scheduled-tasks.json`, and a `skills-plugin/` folder. There were **no conversation transcripts**, so there was nothing to build or test against. Someone who uses Cowork heavily should check whether transcripts appear here. That makes this a good first contribution.
- **Regular chats** (claude.ai, desktop Chat, mobile) are stored in the account. The app's `IndexedDB` / `Local Storage` hold only an internal cache, which is not a supported or stable format, so PromptVault does not read it.

→ Chats are supported through the **official export**: Settings → Privacy → Export data. You get a zip by email.

## Claude.ai export ✅ (`claude-export`)

The zip contains `conversations.json` (plus `users.json`, `projects.json`). `conversations.json` is a JSON array:

```jsonc
{ "uuid": "…", "name": "Title or empty string", "summary": "…",
  "created_at": "2026-04-01T09:00:00.000000Z", "updated_at": "…",
  "account": { "uuid": "…" },
  "chat_messages": [
    { "uuid": "…", "sender": "human" | "assistant", "text": "flattened text",
      "content": [ { "type": "text", "text": "…" }, { "type": "thinking", … },
                   { "type": "tool_use", "name": "…", "input": {…} },
                   { "type": "tool_result", "content": [ { "type": "text", "text": "…" } ] } ],
      "created_at": "…", "attachments": [ { "file_name": "…", "extracted_content": "…" } ], "files": [ … ] } ] }
```

PromptVault prefers `content` blocks and falls back to `text` when `content` is missing (older exports). Attachments with `extracted_content` are indexed as tool output, so they are searchable without polluting "My prompts". Empty conversations are skipped. **Not verified on a real export.** Field names come from community descriptions and knowledge of the format, and they should be checked against a fresh export before launch.

## ChatGPT export ✅ (`chatgpt`)

Settings → Data controls → Export data sends a zip by email. It contains `conversations.json` (and `chat.html`, `user.json`, `message_feedback.json`, and others). `conversations.json` is a JSON array of conversations:

```jsonc
{ "title": "…", "create_time": 1767225600.12 /* Unix seconds, float */, "update_time": …,
  "conversation_id": "…", "id": "…", "current_node": "<node id of the visible leaf>",
  "gizmo_id": null /* or "g-…" for GPTs/Projects */,
  "mapping": { "<node id>": { "id": "…", "parent": "<id>|null", "children": ["…"],
      "message": null | { "author": { "role": "user|assistant|system|tool", "name": … },
        "create_time": …, "recipient": "all" | "python" | "browser" | …,
        "content": { "content_type": "text", "parts": ["…"] },
        "metadata": { "is_visually_hidden_from_conversation": true?, … } } } } }
```

**The message tree.** Editing a prompt or regenerating an answer adds a sibling branch, and `mapping` keeps every branch. PromptVault starts at `current_node` (the branch you last saw), follows `parent` up to the root, and reverses the result. If `current_node` is missing, it uses the newest leaf. Discarded branches are not indexed.

**`content_type` handling:** `text` / `multimodal_text` read `parts` (string parts, plus `audio_transcription.text`, with image pointers skipped). `code` (assistant → tool, where `recipient` ≠ `all`) becomes `tool_call`. `execution_output`, `tether_quote`, `tether_browsing_display`, and messages with role `tool` become `tool_result`. Skipped: `thoughts`, `reasoning_recap` (reasoning), `user_editable_context` (custom instructions), `model_editable_context` (memory), the `system` role, and anything with `is_visually_hidden_from_conversation`. Text is UTF-8 JSON, with non-ASCII characters often `\u`-escaped, which is handled by `JSON.parse`.

Exports from heavy users reach hundreds of MB, so the file is read as a stream, one conversation at a time. **Not verified on a real export.** OpenAI changes this format from time to time, which community threads confirm.

## Gemini (Google Takeout) ✅ (`gemini`), least certain

takeout.google.com → *Deselect all* → tick **My Activity** → *All activity data included* → only **Gemini Apps** → *Multiple formats* → change Activity records from HTML to **JSON**. (The separate "Gemini" Takeout product exports Gems, not chats.) The file is `Takeout/My Activity/Gemini Apps/MyActivity.json`. History exists only if *Gemini Apps Activity* was turned on.

It is a JSON array of My Activity records (fields per Google's [My Activity schema](https://developers.google.com/data-portability/schema-reference/my_activity)): `header` ("Gemini Apps"), `title`, `time` (ISO), `products` (["Gemini Apps"]), `activityControls`, `attachedFiles`, and, specific to Gemini, `safeHtmlItem: [{ html }]` holding the response as HTML.

- **One record is one prompt plus its response.** The prompt is in `title` with the prefix `"Prompted "`. Records such as "Used Gemini Apps" carry no prompt and are skipped.
- **There are no conversation IDs.** PromptVault groups records less than 30 minutes apart into one session. Records come newest first, so grouping happens while streaming.
- **Caveats:** the `"Prompted "` prefix is probably localized in non-English accounts (records with a response but no known prefix are still kept, with the full title used as the prompt). Responses are HTML that gets converted to text. The HTML-only export is **not** supported. **Not verified on a real Takeout.**

## Codex CLI 📄 (documented, not built)

- Location: `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`. Some versions or settings write `.jsonl.zst` (Zstandard), and sources disagree on this.
- Each line is `{ "timestamp", "type", "payload" }` with `type` one of `session_meta` (id, cwd, git info, CLI version), `turn_context`, `response_item` (messages with `role` user/assistant, plus `function_call` / `function_call_output` paired by `payload.call_id`), `event_msg`, and `compacted`.
- Size: single sessions reportedly reach GBs because of repeated compaction history, so streaming is required.
- Plan: a `type: 'local'` plugin. `user` `response_item`s are prompts, but Codex also injects environment context and AGENTS.md as user-role items, which have to be filtered out. Plain `.jsonl` needs no dependencies. `.zst` would need a decompressor, and Node has none built in (`zlib` added zstd only recently, version-dependent).
- Sources: [codex.danielvaughan.com: rollout format](https://codex.danielvaughan.com/2026/06/01/codex-cli-session-history-local-search-rollout-format-knowledge-mining/), [docs.rs/toolpath-codex](https://docs.rs/toolpath-codex).

## Cursor 📄 (documented, not built)

- Location: `…/Cursor/User/globalStorage/state.vscdb` (macOS `~/Library/Application Support/Cursor/`, Windows `%APPDATA%\Cursor\`, Linux `~/.config/Cursor/`). There is also one `workspaceStorage/<hash>/state.vscdb` per project, with `workspace.json` mapping each hash to a folder.
- These are SQLite databases. Tables: `ItemTable` and `cursorDiskKV` (key/value with JSON values). Chat metadata is in `composerData:<composerId>` and messages in `bubbleId:<composerId>:<bubbleId>` (text, code blocks, tool results). Older versions used `ItemTable` key `workbench.panel.aichat…`.
- Caveats: the files can be **tens of GB**, they are locked while Cursor runs (copy or read-only open needed), and the schema changes between Cursor releases. Users report updates wiping history.
- Plan: a `type: 'local'` plugin using `node:sqlite` opened read-only. It is feasible, but it needs real data from someone running a current Cursor.
- Sources: [Cursor forum: state.vscdb growth](https://forum.cursor.com/t/state-vscdb-grows-to-30gb-due-to-bubbleid-agentkv-entries/167641), [cursor-conversations-mcp research notes](https://glama.ai/mcp/servers/@vltansky/cursor-conversations-mcp/blob/48bb781420ad39fbf27623ef5a16cad188612edc/docs/research.md).

## Research sources

- Claude Code and the Claude desktop app: inspected directly on the maintainer's Windows machine (structure only, with content not copied into this repo). Fixtures in `test/fixtures/claude-code` are hand-written imitations.
- ChatGPT: [OpenAI community: decoding conversations.json](https://community.openai.com/t/decoding-exported-data-by-parsing-conversations-json-and-or-chat-html/403144), [ai-chat-importer.com: export format explained](https://ai-chat-importer.com/guides/chatgpt-export-format-explained), [Level Up: "your ChatGPT history is a tree"](https://levelup.gitconnected.com/your-chatgpt-history-is-a-tree-not-a-transcript-2026-5660ceb301d4).
- Claude export: [ai-chat-importer.com: export Claude conversations](https://ai-chat-importer.com/blog/how-to-export-claude-conversations), [univik.com help](https://univik.com/help/export-claude-chats.html).
- Gemini: [Google My Activity schema](https://developers.google.com/data-portability/schema-reference/my_activity), [takeoutday.org Gemini guide](https://takeoutday.org/guides/gemini-data-export), [xtrace.ai](https://xtrace.ai/blog/how-to-export-gemini-conversations).
