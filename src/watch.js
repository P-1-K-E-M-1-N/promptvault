// --watch: re-index session files as they are written.
// Uses recursive fs.watch (Windows, macOS, and Linux on Node 20+), with a
// polling fallback for filesystems where watching is not supported.

import fs from 'node:fs';
import path from 'node:path';
import { sources } from './sources/index.js';
import { indexFile } from './indexer.js';

const DEBOUNCE_MS = 1500;
const POLL_MS = 15000;

export function startWatch(store, opts, progress, onChange) {
  const timers = new Map();
  const closers = [];
  let busy = Promise.resolve();

  const schedule = (plugin, file) => {
    clearTimeout(timers.get(file));
    timers.set(file, setTimeout(() => {
      timers.delete(file);
      busy = busy.then(async () => {
        const n = await indexFile(store, plugin, file, progress);
        if (n) onChange?.({ file, sessions: n });
      }).catch(() => {});
    }, DEBOUNCE_MS));
  };

  for (const plugin of sources.filter((s) => s.type === 'local' && s.watchRoots)) {
    for (const root of plugin.watchRoots(opts)) {
      if (!fs.existsSync(root)) continue;
      try {
        const w = fs.watch(root, { recursive: true }, (_event, name) => {
          if (name && String(name).endsWith('.jsonl')) schedule(plugin, path.join(root, String(name)));
        });
        w.on('error', () => {});
        closers.push(() => w.close());
      } catch {
        // Fallback: re-scan periodically; unchanged files are skipped cheaply.
        const t = setInterval(async () => {
          for (const file of await plugin.detect(opts)) schedule(plugin, file);
        }, POLL_MS);
        closers.push(() => clearInterval(t));
      }
    }
  }
  return () => { closers.forEach((c) => c()); timers.forEach(clearTimeout); };
}
