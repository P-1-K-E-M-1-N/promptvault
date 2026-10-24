import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { openStore, defaultDataDir, wipeDataDir } from './db.js';
import { createProgress, indexLocal, importPath } from './indexer.js';
import { createServer } from './server.js';
import { startWatch } from './watch.js';
import { sessionToMarkdown, libraryToMarkdown, sourceName } from './markdown.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `
PromptVault ${pkg.version}: every prompt you've ever written to an AI, searchable in one place.
Runs on your machine. Nothing uploaded.

Usage
  npx promptvault                     Index Claude Code history, open the search UI
  npx promptvault --watch             ...and keep indexing new sessions as they are written
  npx promptvault import <file|dir>   Import a ChatGPT / Claude / Gemini export (.zip, .json, or folder)
  npx promptvault search <words>      Search from the terminal (add --prompts for your prompts only)
  npx promptvault index               Index only, print a summary, no browser
  npx promptvault export --library    Print the Prompt Library as Markdown (use -o file.md to save)
  npx promptvault export --session <id>
  npx promptvault wipe                Delete the local database and imported copies
  npx promptvault where               Show which files are read and where the index lives

Options
  --import <path>       Import an export before opening the UI (repeatable)
  --port <n>            Port for the local UI (default 4517; next free port is used if busy)
  --no-open             Don't open the browser
  --db <file>           Use a different database file
  --claude-dir <dir>    Read Claude Code history from this folder instead of ~/.claude
  --prompts             (search) only your own prompts
  --limit <n>           (search) number of results, default 20
  -o, --out <file>      (export) write to a file instead of the terminal
  -y, --yes             (wipe) don't ask for confirmation
  -h, --help            Show this help
  -v, --version         Show version
`;

export function parseArgs(argv) {
  const args = { _: [], import: [], open: true, port: 4517 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '-h': case '--help': args.help = true; break;
      case '-v': case '--version': args.version = true; break;
      case '--watch': case '-w': args.watch = true; break;
      case '--no-open': args.open = false; break;
      case '--port': args.port = Number(next()); break;
      case '--db': args.db = next(); break;
      case '--claude-dir': args.claudeDir = next(); break;
      case '--import': args.import.push(next()); break;
      case '--prompts': args.prompts = true; break;
      case '--limit': args.limit = Number(next()); break;
      case '--library': args.library = true; break;
      case '--session': args.session = next(); break;
      case '-o': case '--out': args.out = next(); break;
      case '-y': case '--yes': args.yes = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option ${a}. Run with --help.`);
        args._.push(a);
    }
  }
  return args;
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const argv = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    const child = spawn(cmd, argv, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch { /* the URL is printed anyway */ }
}

function summaryLine(totals) {
  const cc = totals.bySource.find((s) => s.source === 'claude-code');
  if (!cc) return 'No Claude Code history found yet.';
  return `Found ${cc.sessions} session${cc.sessions === 1 ? '' : 's'} across ${cc.projects} project${cc.projects === 1 ? '' : 's'}.`;
}

function progressPrinter() {
  if (!process.stderr.isTTY) return () => {};
  let last = 0;
  return (p) => {
    const now = Date.now();
    if (now - last < 120 && p.filesDone < p.filesTotal) return;
    last = now;
    const pct = p.filesTotal ? Math.round((p.filesDone / p.filesTotal) * 100) : 100;
    process.stderr.write(`\r  Indexing ${p.filesDone}/${p.filesTotal} files (${pct}%) · ${p.sessions} sessions updated   `);
  };
}

const plain = (s) => s.replace(/\u0001|\u0002/g, '').replace(/\s+/g, ' ').trim();

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) return void console.log(HELP);
  if (args.version) return void console.log(pkg.version);

  const dataDir = args.db ? path.dirname(path.resolve(args.db)) : defaultDataDir();
  const dbPath = args.db ? path.resolve(args.db) : path.join(dataDir, 'index.db');
  const opts = { claudeDir: args.claudeDir };
  const cmd = args._[0] || 'serve';

  if (cmd === 'wipe') {
    if (!args.yes) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Delete ${dbPath} and imported copies in ${path.join(dataDir, 'imports')}? Your original AI history files are not touched. [y/N] `);
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) return void console.log('Cancelled.');
    }
    const removed = wipeDataDir(dbPath, dataDir);
    console.log(removed.length ? `Deleted:\n  ${removed.join('\n  ')}` : 'Nothing to delete.');
    return;
  }

  if (cmd === 'where') {
    const { claudeRoots } = await import('./sources/claude-code.js');
    console.log('PromptVault reads (never writes) these folders:');
    for (const r of claudeRoots(opts)) console.log(`  ${r}`);
    console.log('…plus any export file you import yourself.\n');
    console.log(`Index database: ${dbPath}`);
    console.log(`Imported copies: ${path.join(dataDir, 'imports')}`);
    return;
  }

  const store = openStore(dbPath);
  const progress = createProgress();

  if (cmd === 'import') {
    if (!args._[1]) throw new Error('Usage: promptvault import <file|folder|zip>');
    for (const target of args._.slice(1)) {
      const results = await importPath(store, target, progress);
      if (!results.length) console.log(`${target}: no supported export found (ChatGPT, Claude, Gemini Takeout).`);
      for (const r of results) console.log(`Imported ${r.sessions} ${sourceName(r.source)} session(s) from ${r.name}`);
    }
    for (const e of progress.errors) console.error(`  ! ${e}`);
    store.close();
    return;
  }

  if (cmd === 'search') {
    const q = args._.slice(1).join(' ');
    const { total, rows } = store.search({ q, kinds: args.prompts ? ['user_prompt'] : [], limit: args.limit || 20 });
    console.log(`${total} match${total === 1 ? '' : 'es'}${args.prompts ? ' in your prompts' : ''}\n`);
    for (const r of rows) {
      const date = r.ts ? new Date(r.ts).toISOString().slice(0, 10) : '';
      console.log(`[${sourceName(r.source)}] ${r.title}  ${date}`);
      console.log(`  ${plain(r.snippet).slice(0, 220)}`);
      console.log(`  id: ${r.session_id}\n`);
    }
    store.close();
    return;
  }

  if (cmd === 'export') {
    let md;
    if (args.session) {
      const s = store.getSession(args.session);
      if (!s) throw new Error(`No session with id ${args.session}`);
      md = sessionToMarkdown(s);
    } else if (args.library) {
      md = libraryToMarkdown(store.listStars());
    } else {
      throw new Error('Usage: promptvault export --library | --session <id> [-o file.md]');
    }
    if (args.out) { fs.writeFileSync(args.out, md); console.log(`Wrote ${args.out}`); } else process.stdout.write(md);
    store.close();
    return;
  }

  if (cmd !== 'serve' && cmd !== 'index') throw new Error(`Unknown command "${cmd}". Run with --help.`);

  console.log(`PromptVault ${pkg.version} · local only, nothing leaves this machine`);

  if (cmd === 'index') {
    await indexLocal(store, opts, progress, progressPrinter());
    for (const t of args.import) await importPath(store, t, progress);
    if (process.stderr.isTTY) process.stderr.write('\n');
    const totals = store.totals();
    console.log(summaryLine(totals));
    console.log(`Index: ${totals.sessions} sessions, ${totals.prompts} prompts, ${totals.messages} messages total.`);
    for (const e of progress.errors) console.error(`  ! ${e}`);
    store.close();
    return;
  }

  // serve: start the UI first so the person sees progress while indexing runs.
  const ctx = { store, progress, dataDir, watch: !!args.watch, version: pkg.version };
  const ui = createServer(ctx);
  const port = await ui.listen(args.port);
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Search UI: ${url}  (Ctrl+C to stop)`);
  if (args.open) openBrowser(url);

  const firstRun = !store.getMeta('first_run_done');
  await indexLocal(store, opts, progress, progressPrinter());
  for (const t of args.import) {
    const results = await importPath(store, t, progress);
    for (const r of results) console.log(`\nImported ${r.sessions} ${sourceName(r.source)} session(s) from ${r.name}`);
  }
  if (process.stderr.isTTY) process.stderr.write('\n');
  const totals = store.totals();
  ctx.firstRunSummary = summaryLine(totals);
  ctx.lastChange = Date.now();
  console.log(ctx.firstRunSummary);
  if (firstRun) store.setMeta('first_run_done', Date.now());
  for (const e of progress.errors.slice(0, 10)) console.error(`  ! ${e}`);

  let stopWatch = () => {};
  if (args.watch) {
    stopWatch = startWatch(store, opts, progress, ({ sessions }) => {
      ctx.lastChange = Date.now();
      console.log(`  ↻ re-indexed ${sessions} session(s) at ${new Date().toLocaleTimeString()}`);
    });
    console.log('Watching for new sessions…');
  }

  ctx.onWipe = () => {
    stopWatch();
    store.close();
    wipeDataDir(dbPath, dataDir);
    console.log('Index wiped from the UI. Server stopped.');
    process.exit(0);
  };

  const shutdown = () => { stopWatch(); try { store.close(); } catch {} process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
