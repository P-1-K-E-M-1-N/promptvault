# Backlog

Deliberately **not built** in v1. Build these only after the launch shows people want the core (see LAUNCH.md for the signals).

## ⭐ Top v2 candidate: MCP server

An MCP server (`promptvault mcp`) that lets coding agents search your past sessions themselves. For example: *"have I solved this ECONNRESET before?"*, *"what prompt did I use to set up the release script in the other repo?"*.

- Why it's first: it turns a tool you open occasionally into something your agent uses every day. That's the biggest reason to keep PromptVault installed. The search core (`store.search`, `store.getSession`) already exists, so the server is a thin layer: tools `search_sessions`, `get_session`, `list_prompt_library`.
- Must keep the privacy promise: stdio transport only (no network listener), read-only, opt-in per agent.
- Open question: how much past context to return without flooding the agent's context window (snippets plus on-demand session fetch).

## Later

- **Semantic / vector search** ("find the session where I fought with auth redirects" without the exact words). It needs a local embedding model, which is a big download and conflicts with zero dependencies. Possibly an optional add-on.
- **Auto-clustering sessions into topics.** Depends on embeddings, see above.
- **Team / shared vaults.** Share a curated Prompt Library with your team. Needs a sync story that doesn't break "nothing uploaded" (for example, export/import of library files through git).
- **Cloud sync** between your own machines. Same tension. A file-based approach (sync the library Markdown through your own Dropbox/git) is likely the honest answer.
- **Desktop app wrapper** (Tauri/Electron) for people without Node. A one-click installer and a tray icon running `--watch`.

## Smaller improvements noticed while building

- **Sources:** Codex CLI and Cursor (formats documented in FORMATS.md, good first contributions). Cowork transcripts (need real data). Copilot Chat, Aider, Windsurf, Continue, Zed, Perplexity, Grok.
- **Append-only re-indexing:** when a Claude Code file grows, read only the new lines instead of re-reading the whole file. It matters only for very long-running sessions.
- **Gemini:** support the HTML Takeout format and non-English "Prompted" prefixes. Group by real conversation if Google ever exports conversation ids.
- **Search:** exclude words (`-word`), `OR`, per-session grouping of results, "find similar prompts" via FTS.
- **Reader:** render Markdown fully (tables, lists), and virtualize very long sessions (10k+ messages).
- **Library:** tags/notes on starred prompts, prompt templates with `{{variables}}`.
- **Index size:** optional `--no-tool-output` to roughly halve the database.
