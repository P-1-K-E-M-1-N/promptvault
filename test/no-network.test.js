// Guards the "zero network calls" promise: the shipped code may create a local
// server, but must never contain a way to make an outgoing request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.(js|html|css)$/.test(e.name) ? [p] : [];
  });
}

const FORBIDDEN = [
  [/from\s+['"]node:(https|net|dgram|dns|tls|http2)['"]/, 'imports a network module'],
  [/require\(['"](node:)?(https|net|dgram|dns|tls|http2)['"]\)/, 'requires a network module'],
  [/\bhttp\.(request|get)\s*\(/, 'makes an outgoing HTTP request'],
  [/\bnew\s+(WebSocket|EventSource)\b/, 'opens a socket'],
  [/navigator\.sendBeacon/, 'sends a beacon'],
  [/https?:\/\/(?!127\.0\.0\.1|localhost|github\.com\/YOUR_GITHUB_USERNAME|github\.com\/sponsors\/YOUR_GITHUB_USERNAME)[a-z]/i, 'references a remote URL'],
];

test('no outgoing network code in src/, bin/ or public/', () => {
  const problems = [];
  for (const dir of ['src', 'bin', 'public']) {
    for (const file of files(path.join(ROOT, dir))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const [re, why] of FORBIDDEN) if (re.test(text)) problems.push(`${path.relative(ROOT, file)} ${why}`);
      // fetch() is only allowed in the browser UI, and only with relative URLs.
      if (/\bfetch\s*\(/.test(text) && !file.endsWith(path.join('public', 'app.js'))) problems.push(`${path.relative(ROOT, file)} calls fetch()`);
    }
  }
  const ui = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  for (const m of ui.matchAll(/fetch\(\s*([^,)]+)/g)) {
    if (!/^path\b/.test(m[1].trim())) problems.push(`public/app.js fetch target ${m[1]} is not the local api() path`);
  }
  assert.deepEqual(problems, []);
});

test('package has no runtime dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies || {}), []);
});
