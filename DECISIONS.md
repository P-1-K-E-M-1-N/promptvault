# Decisions

The main choices behind PromptVault v1, explained without jargon. Each one says what was picked, why, and what it costs.

## 1. It runs on your computer, not on a website

**What:** You type `npx promptvault`. A small program starts on your computer, reads your AI history, and opens a search page in your browser. The page is served by that program, not by the internet.

**Why:** The whole promise is "nothing uploaded." A website would mean your private prompts sit on someone's server. Running locally also means no accounts, no hosting bills, and nothing to shut down if the project goes quiet.

**Cost:** You need Node.js installed. Many developers already have it, but a non-developer might not. A one-click desktop app is in the backlog.

## 2. Zero network calls, and no dependencies at all

**What:** PromptVault never connects to anything: no analytics, no "check for updates," no fonts from Google. It also uses **no third-party packages**, only what ships with Node itself.

**Why:** Privacy tools are only trustworthy if people can check them. With no dependencies, anyone can read the whole program in an afternoon and confirm it doesn't phone home. There's no pile of downloaded code where something could hide. It also makes `npx` start fast and keeps out a whole category of security problems (compromised packages).

**Cost:** Some things had to be written by hand that a package would normally do: reading zip files, and reading huge JSON files bit by bit. That's about 200 lines, and it has tests.

## 3. SQLite with full-text search, built into Node

**What:** Your history is copied into one database file on your computer. "Full-text search" (SQLite's FTS5) works like a book's index: it knows which messages contain each word, so searches are instant instead of re-reading every file.

**Why:** SQLite is the most widely used database in the world, and it's a single file you can delete. Recent Node versions include SQLite, so nothing has to be compiled during installation. Compilation is the most common reason `npx` tools fail on Windows.

**Cost:** It requires Node 22.23+ or 24+. Earlier versions (including all of Node 23) ship SQLite without the full-text search part, which we found out from the first CI run. Older versions get a clear message saying so.

## 4. One plugin file per AI tool

**What:** Each source (Claude Code, ChatGPT, …) is one file that does two things: *find* the history (`detect`) and *translate* it into one common shape (`parse`). The rest of the program only ever sees that common shape: who said it, what they said, whether it was a prompt, a reply, or a tool step, and when.

**Why:** Every AI tool stores history differently, and the formats change often. Keeping each one in its own file means a format change breaks one file, not the app. It also means an outside contributor can add a new tool without understanding the rest of the code. Contributors adding sources is our strongest success signal (see LAUNCH.md).

## 5. "My prompts only" has to be trustworthy

**What:** The headline switch searches only the words *you* typed.

**Why it took care:** In Claude Code's files, most "user" entries aren't the person at all. On the test machine, only **92 of 1,951** were real prompts. The rest were tool results, background-task notices, messages between agents, and hidden reminders the app injects. Each parser has to sort these carefully. If it doesn't, the killer feature fills up with junk. Every parser's tests check this.

## 6. Built for very large histories

**What:** Files are read piece by piece (streaming), never all at once. Each file's size and modification date are remembered, so the next run only reads files that changed. The search page opens immediately and shows a progress bar while indexing happens in the background.

**Measured** on a Windows laptop with 10,000 sessions plus one 300 MB transcript (525 MB total):
- First index: **27 seconds**. The page answered every check within 0.15 seconds during that time.
- Next run, nothing changed: **0.3 seconds**.
- Searches: about 0.3–0.4 seconds for very common words, and instant for specific ones.

**Cost:** When a file changes, that whole file is re-read rather than only the new lines. That's simple and always correct, but it's slower for one enormous, still-growing session. It's fine for v1, and noted in the backlog.

## 7. Chat apps come in through their official exports

**What:** ChatGPT, Claude.ai, and Gemini don't keep your chats on your disk. They live in your account. PromptVault reads the **official export** you download (a zip file), which you can drag onto the page.

**Why:** The alternative is logging into those services or scraping their apps. That would break PromptVault's promise (it would need network access and your passwords) and would break whenever the apps change. Exports are official and permanent.

**Cost:** You have to request an export and wait for an email, and the data is only as fresh as your last export. *Note:* the export parsers were built from published descriptions of the formats and tested on hand-made sample files, **not yet on real exports**. That has to be checked before launch (see LAUNCH.md).

## 8. What gets indexed, and what doesn't

- **Indexed:** your prompts, AI replies, tool calls, and tool output. Tool output is how you find "that error message from last month." It's cut off at 8 KB per step so one huge log can't swamp the index.
- **Not indexed:** the AI's hidden "thinking" (Claude Code saves it blank on disk anyway, and ChatGPT's is internal), images, ChatGPT branches you edited away, and app bookkeeping.
- **By default, search covers prompts and replies.** Tool output is one checkbox away. It's off by default because on the test machine tool steps outnumbered human prompts about 40 to 1.

## 9. Small security choices for a local web page

A program serving a web page on your machine could, in theory, be poked by a malicious website you visit at the same time. PromptVault blocks this in three ways. It only answers requests addressed to your own machine by name (this stops a trick called DNS rebinding). It ignores any change request that lacks a special header other websites can't add. And the page itself is forbidden from loading anything external. All three are covered by tests.

## 10. Small enough to prove demand, then stop

v1 does one job well: search across tools. Clever extras (AI-powered "semantic" search, topic clustering, team sharing, sync, a desktop app, an agent plug-in) are written down in BACKLOG.md and not built. If people use the simple version, we'll know which extra they actually want.

---

## Name: three better options

"PromptVault" is descriptive, but a vault suggests locking things away, while this tool is about *finding* them. It's also crowded: a `prompt-vault` package and several similar apps already exist. All three alternatives below were **free on npm on 2026-10-24**. GitHub org and domain availability were not checked.

1. **Everprompt** (`npx everprompt`). *"Every prompt you've ever written."* Short, friendly, and the name is the pitch. ⭐ Recommended.
2. **sessiongrep** (`npx sessiongrep`). Talks straight to developers ("grep" is the classic search command). Very clear to the launch audience, a bit cold for anyone else.
3. **PromptRecall** (`npx promptrecall`). Says exactly what it does. Downside: "Recall" is also the name of a controversial Windows screen-recording feature, which could cause privacy-flavored confusion.

The code uses `promptvault` (also currently free on npm). Renaming before launch means changing `package.json`, the README, and the UI title.
