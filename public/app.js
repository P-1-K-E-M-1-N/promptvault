// PromptVault UI. Plain JavaScript, no framework, no external requests:
// every fetch() below goes to the local server that served this page.

const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const SOURCE_NAMES = { 'claude-code': 'Claude Code', chatgpt: 'ChatGPT', 'claude-export': 'Claude', gemini: 'Gemini' };
const KIND_LABEL = { user_prompt: 'Your prompt', assistant_reply: 'Reply', tool_call: 'Tool call', tool_result: 'Tool output' };
const PAGE = 40;

const state = { results: [], total: 0, offset: 0, lastQueryKey: '', facets: null, status: null };

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sourceName = (id) => SOURCE_NAMES[id] || id;
const shortProject = (p) => (p ? p.split(/[\\/]/).filter(Boolean).pop() || p : '');
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

// Snippets arrive with \u0001 / \u0002 around matches; escape first, then mark.
const markSnippet = (s) => esc(s).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.body && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), 'X-PromptVault': '1', ...(opts.headers || {}) },
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied to clipboard');
}

// Very small renderer: ``` fences become code blocks, `inline` becomes code.
function renderText(text) {
  const parts = String(text).split(/```[^\n]*\n?/);
  return parts.map((part, i) => {
    if (i % 2 === 1) return `<pre>${esc(part.replace(/\n$/, ''))}</pre>`;
    return esc(part).replace(/`([^`\n]+)`/g, '<code>$1</code>');
  }).join('');
}

function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- routing ----------
function route() {
  const hash = location.hash.slice(1) || '/search';
  const [pathPart, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  const [, name, ...rest] = pathPart.split('/');
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (name === 'session' ? 'search' : name)));
  const showSearch = name === 'search' || name === 'session' || !name;
  $('#filters').hidden = name !== 'search' && !!name;
  if (name === 'session') return renderSession(decodeURIComponent(rest.join('/')), params.has('seq') ? Number(params.get('seq')) : NaN);
  if (name === 'library') return renderLibrary();
  if (name === 'import') return renderImport();
  if (name === 'about') return renderAbout();
  if (showSearch) {
    // Bookmarkable searches: #/search?q=retry&mine=1
    if (params.has('q')) $('#q').value = params.get('q');
    if (params.has('mine')) $('#mine').checked = params.get('mine') === '1';
    return runSearch(true);
  }
}
window.addEventListener('hashchange', route);

// ---------- search ----------
function readFilters() {
  const day = (v, end) => (v ? new Date(v + (end ? 'T23:59:59' : 'T00:00:00')).getTime() : '');
  const mine = $('#mine').checked;
  const kinds = mine ? 'user_prompt' : $('#f-tools').checked ? '' : 'user_prompt,assistant_reply';
  return {
    q: $('#q').value.trim(),
    kinds,
    source: $('#f-source').value,
    project: $('#f-project').value,
    from: day($('#f-from').value),
    to: day($('#f-to').value, true),
    sort: $('#f-sort').value,
  };
}

function saveFilters() {
  try {
    localStorage.setItem('pv.filters', JSON.stringify({ mine: $('#mine').checked, tools: $('#f-tools').checked, sort: $('#f-sort').value }));
  } catch { /* storage unavailable */ }
}
function loadFilters() {
  try {
    const f = JSON.parse(localStorage.getItem('pv.filters') || '{}');
    $('#mine').checked = !!f.mine;
    $('#f-tools').checked = !!f.tools;
    if (f.sort) $('#f-sort').value = f.sort;
  } catch { /* ignore */ }
}

async function runSearch(fresh) {
  if (!location.hash.startsWith('#/search') && location.hash) { location.hash = '#/search'; return; }
  const f = readFilters();
  const key = JSON.stringify(f);
  if (fresh || key !== state.lastQueryKey) { state.offset = 0; state.results = []; }
  state.lastQueryKey = key;

  // Nothing typed and not in prompts mode: show recent sessions instead.
  if (!f.q && !$('#mine').checked) return renderRecentSessions(f);

  const params = new URLSearchParams({ ...f, limit: PAGE, offset: state.offset });
  for (const [k, v] of [...params]) if (v === '') params.delete(k);
  let data;
  try {
    data = await api('/api/search?' + params);
  } catch (err) {
    view.innerHTML = `<div class="empty"><h2>Search failed</h2><p>${esc(err.message)}</p></div>`;
    return;
  }
  if (key !== state.lastQueryKey) return; // a newer search started meanwhile
  state.results = state.offset ? state.results.concat(data.rows) : data.rows;
  state.total = data.total;
  state.capped = !!data.capped;
  renderResults(f);
}

function renderResults(f) {
  const mine = $('#mine').checked;
  if (!state.results.length) {
    view.innerHTML = `<div class="empty"><h2>No matches${mine ? ' in your prompts' : ''}</h2>
      <p>${state.status?.totals?.sessions ? 'Try fewer words, or turn off filters.' : 'Nothing is indexed yet. Import an export, or run Claude Code once.'}</p></div>`;
    return;
  }
  const what = mine ? (f.q ? 'of your prompts match' : 'prompts, newest first') : 'matches';
  view.innerHTML = `<p class="summary">${state.total.toLocaleString()}${state.capped ? '+' : ''} ${what}</p>
    <ul class="results">${state.results.map(resultCard).join('')}</ul>
    ${state.results.length < state.total ? '<button class="btn more" id="more">Load more</button>' : ''}`;
  $('#more')?.addEventListener('click', () => { state.offset = state.results.length; runSearch(false); });
}

function resultCard(r) {
  const href = `#/session/${encodeURIComponent(r.session_id)}?seq=${r.seq}`;
  return `<li><a class="card" href="${href}">
    <div class="meta"><span class="badge ${esc(r.source)}">${esc(sourceName(r.source))}</span>
      ${r.project ? `<span title="${esc(r.project)}">${esc(shortProject(r.project))}</span>·` : ''}
      <span>${esc(fmtDate(r.ts))}</span>· <span class="kind ${esc(r.kind)}">${esc(KIND_LABEL[r.kind] || r.kind)}</span></div>
    <h3>${esc(r.title)}</h3>
    <p class="snippet">${markSnippet(r.snippet)}</p></a></li>`;
}

async function renderRecentSessions(f) {
  const params = new URLSearchParams({ limit: PAGE, offset: state.offset });
  if (f.source) params.set('source', f.source);
  if (f.project) params.set('project', f.project);
  const data = await api('/api/sessions?' + params);
  const rows = state.offset ? state.results.concat(data.rows) : data.rows;
  state.results = rows;
  state.total = data.total;
  if (!rows.length) {
    view.innerHTML = `<div class="empty"><h2>Nothing indexed yet</h2>
      <p>Claude Code history is picked up automatically. For ChatGPT, Claude.ai, or Gemini, <a href="#/import">import an export</a>.</p></div>`;
    return;
  }
  view.innerHTML = `<p class="summary">${data.total.toLocaleString()} sessions, most recent first. Type to search, or flip on <b>My prompts only</b>.</p>
    <ul class="results">${rows.map((s) => `<li><a class="card" href="#/session/${encodeURIComponent(s.id)}">
      <div class="meta"><span class="badge ${esc(s.source)}">${esc(sourceName(s.source))}</span>
        ${s.project ? `<span title="${esc(s.project)}">${esc(shortProject(s.project))}</span>·` : ''}
        <span>${esc(fmtDate(s.ended_at || s.started_at))}</span>·
        <span>${s.n_prompts} prompt${s.n_prompts === 1 ? '' : 's'}</span></div>
      <h3>${esc(s.title)}</h3></a></li>`).join('')}</ul>
    ${rows.length < data.total ? '<button class="btn more" id="more">Load more</button>' : ''}`;
  $('#more')?.addEventListener('click', () => { state.offset = state.results.length; renderRecentSessions(f); });
}

// ---------- session reader ----------
async function renderSession(id, targetSeq) {
  view.innerHTML = '<p class="summary">Loading…</p>';
  let s;
  try {
    s = await api('/api/session?id=' + encodeURIComponent(id));
  } catch (err) {
    view.innerHTML = `<div class="empty"><h2>Session not found</h2><p>${esc(err.message)}</p></div>`;
    return;
  }
  // Group consecutive tool calls/results into one collapsed block.
  const blocks = [];
  for (const m of s.messages) {
    const isTool = m.kind === 'tool_call' || m.kind === 'tool_result';
    const last = blocks[blocks.length - 1];
    if (isTool && last?.tools) last.tools.push(m);
    else if (isTool) blocks.push({ tools: [m] });
    else blocks.push({ msg: m });
  }

  const html = blocks.map((b) => {
    if (b.tools) {
      const open = b.tools.some((m) => m.seq === targetSeq);
      return `<details class="tools"${open ? ' open' : ''}><summary>${b.tools.length} tool step${b.tools.length === 1 ? '' : 's'}</summary>
        ${b.tools.map((m) => `<details class="tool" id="m${m.seq}"${m.seq === targetSeq ? ' open' : ''}>
          <summary>${m.kind === 'tool_call' ? '→' : '←'} ${esc(m.text.split('\n')[0].slice(0, 140))}</summary>
          <pre class="code">${esc(m.text)}</pre></details>`).join('')}</details>`;
    }
    const m = b.msg;
    const isPrompt = m.kind === 'user_prompt';
    return `<article class="msg ${esc(m.kind)}${m.seq === targetSeq ? ' target' : ''}" id="m${m.seq}">
      <div class="msg-head"><span class="who">${isPrompt ? 'You' : m.role === 'assistant' ? 'Assistant' : esc(m.role)}</span>
        <span class="meta">${esc(fmtTime(m.ts))}</span>
        ${isPrompt ? `<span class="msg-tools">
          <button class="btn small" data-copy="${m.seq}">Copy</button>
          <button class="btn small star${m.starred ? ' on' : ''}" data-star="${m.seq}" aria-pressed="${m.starred}">${m.starred ? '★ Saved' : '☆ Save'}</button>
        </span>` : ''}</div>
      <div class="body">${renderText(m.text)}</div></article>`;
  }).join('');

  view.innerHTML = `<div class="reader-head"><div>
      <div class="meta"><span class="badge ${esc(s.source)}">${esc(sourceName(s.source))}</span>
        ${s.project ? `<span title="${esc(s.project)}">${esc(s.project)}</span>·` : ''}<span>${esc(fmtTime(s.started_at))}</span>·
        <span>${s.n_prompts} prompts, ${s.n_messages} messages</span></div>
      <h1>${esc(s.title)}</h1></div>
    <div class="reader-actions">
      <button class="btn" id="back">← Back</button>
      <button class="btn" id="export">Export Markdown</button>
    </div></div>
    <div class="thread">${html}</div>`;

  const bySeq = new Map(s.messages.map((m) => [m.seq, m]));
  $('#back').addEventListener('click', () => (history.length > 1 ? history.back() : (location.hash = '#/search')));
  $('#export').addEventListener('click', () => download('/api/export/session?id=' + encodeURIComponent(id)));
  view.querySelectorAll('[data-copy]').forEach((btn) => btn.addEventListener('click', () => copyText(bySeq.get(Number(btn.dataset.copy)).text)));
  view.querySelectorAll('[data-star]').forEach((btn) => btn.addEventListener('click', async () => {
    const seq = Number(btn.dataset.star);
    const on = !btn.classList.contains('on');
    await api('/api/stars', { method: 'POST', body: JSON.stringify({ session_id: id, seq, starred: on }) });
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on);
    btn.textContent = on ? '★ Saved' : '☆ Save';
    toast(on ? 'Saved to Prompt Library' : 'Removed from Prompt Library');
    refreshStatus();
  }));
  if (Number.isFinite(targetSeq)) document.getElementById('m' + targetSeq)?.scrollIntoView({ block: 'center' });
  else window.scrollTo(0, 0);
}

// ---------- prompt library ----------
async function renderLibrary() {
  const stars = await api('/api/stars');
  if (!stars.length) {
    view.innerHTML = `<div class="empty"><h2>Your Prompt Library is empty</h2>
      <p>Open any session and press <b>☆ Save</b> on a prompt that worked. It lands here, ready to copy.</p></div>`;
    return;
  }
  view.innerHTML = `<div class="reader-head"><div><h1>Prompt Library</h1>
      <p class="summary">${stars.length} saved prompt${stars.length === 1 ? '' : 's'}. Copies are kept even if the original session is deleted.</p></div>
    <div class="reader-actions"><button class="btn primary" id="export-lib">Export library as Markdown</button></div></div>
    <div class="thread">${stars.map((s, i) => `<article class="msg user_prompt lib-item">
      <div class="msg-head"><span class="meta"><span class="badge ${esc(s.source)}">${esc(sourceName(s.source))}</span>
        ${s.project ? esc(shortProject(s.project)) + ' ·' : ''} ${esc(fmtDate(s.ts))} · <a href="#/session/${encodeURIComponent(s.session_id)}?seq=${s.seq}">${esc(s.session_title || 'Open session')}</a></span>
        <span class="msg-tools"><button class="btn small" data-copy="${i}">Copy</button>
        <button class="btn small star on" data-unstar="${i}">★ Remove</button></span></div>
      <div class="body">${renderText(s.text)}</div></article>`).join('')}</div>`;
  $('#export-lib').addEventListener('click', () => download('/api/export/library'));
  view.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText(stars[Number(b.dataset.copy)].text)));
  view.querySelectorAll('[data-unstar]').forEach((b) => b.addEventListener('click', async () => {
    const s = stars[Number(b.dataset.unstar)];
    await api('/api/stars', { method: 'POST', body: JSON.stringify({ session_id: s.session_id, seq: s.seq, starred: false }) });
    refreshStatus();
    renderLibrary();
  }));
}

// ---------- import ----------
function renderImport() {
  view.innerHTML = `<section class="section"><h2>Import a chat export</h2>
      <div class="dropzone" id="dz" tabindex="0" role="button">Drop a <b>.zip</b> or <b>.json</b> export here, or click to choose a file.
        <input type="file" id="file" accept=".zip,.json,.jsonl" hidden></div>
      <p id="import-result" class="summary"></p>
      <p class="summary">The file is copied into PromptVault's own data folder and indexed locally. It is never uploaded anywhere.</p></section>
    <section class="section"><h2>How to get each export</h2>
      <p><b>ChatGPT:</b> Settings → Data controls → Export data. You get an email with a .zip. Drop the zip here as-is.</p>
      <p><b>Claude.ai / Claude desktop chats:</b> Settings → Privacy → Export data. Drop the .zip here.</p>
      <p><b>Gemini:</b> takeout.google.com → Deselect all → tick <b>My Activity</b> → "All activity data included" → only <b>Gemini Apps</b>
        → "Multiple formats" → set Activity records to <b>JSON</b>. Drop the Takeout .zip here.</p>
      <p><b>Claude Code</b> needs no export: it is read straight from <code>~/.claude/projects</code>.</p></section>`;
  const dz = $('#dz');
  const input = $('#file');
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
  input.addEventListener('change', () => { if (input.files[0]) uploadFile(input.files[0]); });
}

async function uploadFile(file) {
  const out = $('#import-result');
  const say = (html) => { if (out) out.innerHTML = html; };
  say(`Importing <b>${esc(file.name)}</b> (${(file.size / 1048576).toFixed(1)} MB)…`);
  toast(`Importing ${file.name}…`);
  try {
    const res = await api('/api/import?name=' + encodeURIComponent(file.name), { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!res.results.length) {
      say(`<span class="err">No supported export found in ${esc(file.name)}.</span> Supported: ChatGPT, Claude.ai, and Gemini (Takeout JSON).`);
      toast('No supported export found');
    } else {
      const n = res.results.reduce((a, r) => a + r.sessions, 0);
      say(`<span class="ok">Imported ${n.toLocaleString()} session${n === 1 ? '' : 's'}</span> from ${res.results.map((r) => esc(sourceName(r.source))).join(', ')}.`);
      toast(`Imported ${n} sessions`);
    }
    await loadFacets();
    refreshStatus();
  } catch (err) {
    say(`<span class="err">Import failed: ${esc(err.message)}</span>`);
  }
}

// Drag-and-drop anywhere on the page.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#drop').hidden = false; } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').hidden = true; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').hidden = true;
  const file = e.dataTransfer?.files?.[0];
  if (file) { if (!location.hash.startsWith('#/import')) location.hash = '#/import'; setTimeout(() => uploadFile(file), 30); }
});

// ---------- privacy / about ----------
function renderAbout() {
  const st = state.status || {};
  view.innerHTML = `<section class="section"><h2>Privacy</h2>
      <p>PromptVault makes <b>zero network calls</b>. No telemetry, no analytics, no update checks. This page talks only to the
      PromptVault process on your own machine (<code>${esc(location.host)}</code>), which listens on 127.0.0.1 and is not reachable from other computers.</p>
      <p>It <b>reads</b> Claude Code transcripts from <code>~/.claude/projects</code> and any export you import. It never changes those files.</p>
      <p>It <b>writes</b> only its own index: <code>${esc(st.dbPath || '')}</code>, plus copies of imports in <code>${esc((st.dataDir || '') + '/imports')}</code>.</p>
      <p>To check for yourself, see "Verify it yourself" in the README.</p></section>
    <section class="section"><h2>Index</h2>
      <p>${(st.totals?.sessions ?? 0).toLocaleString()} sessions, ${(st.totals?.prompts ?? 0).toLocaleString()} prompts, ${(st.totals?.messages ?? 0).toLocaleString()} messages.</p>
      <ul class="steps">${(st.totals?.bySource || []).map((s) => `<li>${esc(sourceName(s.source))}: ${s.sessions.toLocaleString()} sessions</li>`).join('')}</ul>
      <p>Watch mode: ${st.watch ? '<span class="ok">on</span> (new sessions are indexed as they are written)' : 'off (start with <code>npx promptvault --watch</code>)'}</p></section>
    <section class="section"><h2>Wipe index</h2>
      <p>Deletes PromptVault's database and imported copies, then stops the server. Your original AI history is not touched.</p>
      <button class="btn danger" id="wipe">Wipe index…</button></section>`;
  const btn = $('#wipe');
  btn.addEventListener('click', async () => {
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = 'Click again to permanently delete the index';
      setTimeout(() => { btn.classList.remove('armed'); btn.textContent = 'Wipe index…'; }, 5000);
      return;
    }
    await api('/api/wipe', { method: 'POST' });
    view.innerHTML = '<div class="empty"><h2>Index wiped</h2><p>The database was deleted and the server stopped. You can close this tab.</p></div>';
  });
}

// ---------- status / facets ----------
async function loadFacets() {
  const f = await api('/api/facets');
  state.facets = f;
  const src = $('#f-source');
  const keepSrc = src.value;
  src.innerHTML = '<option value="">All sources</option>' + f.sources.map((s) => `<option value="${esc(s.source)}">${esc(sourceName(s.source))} (${s.n})</option>`).join('');
  src.value = keepSrc;
  const proj = $('#f-project');
  const keepProj = proj.value;
  proj.innerHTML = '<option value="">All projects</option>' + f.projects.map((p) => `<option value="${esc(p.project)}" title="${esc(p.project)}">${esc(shortProject(p.project))} (${p.n})</option>`).join('');
  proj.value = keepProj;
}

let lastSeenChange = null;
async function refreshStatus() {
  let st;
  try { st = await api('/api/status'); } catch { return; }
  const prevRunning = state.status?.progress?.running;
  state.status = st;
  $('#star-count').textContent = st.totals.stars || '';
  const box = $('#status');
  const p = st.progress;
  if (p.running) {
    const pct = p.filesTotal ? Math.round((p.filesDone / p.filesTotal) * 100) : 0;
    box.hidden = false;
    box.innerHTML = `<span>Indexing ${p.filesDone.toLocaleString()} / ${p.filesTotal.toLocaleString()} files · ${p.sessions.toLocaleString()} sessions</span>
      <div class="progress"><div id="pbar"></div></div>`;
    $('#pbar').style.width = pct + '%';
  } else if (st.firstRunSummary && !sessionStorage.getItem('pv.seenSummary')) {
    box.hidden = false;
    box.innerHTML = `<span class="found">${esc(st.firstRunSummary)}</span>
      <span>${st.totals.prompts.toLocaleString()} prompts indexed. Try <b>My prompts only</b>.</span>
      <button class="btn small" id="dismiss">Dismiss</button>`;
    $('#dismiss').addEventListener('click', () => { try { sessionStorage.setItem('pv.seenSummary', '1'); } catch {} box.hidden = true; });
  } else {
    box.hidden = true;
  }
  // When indexing finishes or watch mode adds sessions, refresh what is on screen.
  if ((prevRunning && !p.running) || (lastSeenChange && st.lastChange && st.lastChange !== lastSeenChange)) {
    await loadFacets();
    if (location.hash.startsWith('#/search') || !location.hash) runSearch(true);
  }
  lastSeenChange = st.lastChange;
}

// ---------- wiring ----------
let debounce;
$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); location.hash.startsWith('#/search') ? runSearch(true) : (location.hash = '#/search'); });
$('#q').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => runSearch(true), 180); });
for (const id of ['#mine', '#f-source', '#f-project', '#f-from', '#f-to', '#f-sort', '#f-tools']) {
  $(id).addEventListener('change', () => { saveFilters(); runSearch(true); });
}
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') { e.preventDefault(); $('#q').focus(); }
  if (e.altKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); $('#mine').click(); }
});

loadFilters();
await Promise.all([loadFacets().catch(() => {}), refreshStatus()]);
route();
(function poll() {
  setTimeout(() => refreshStatus().finally(poll), state.status?.progress?.running ? 700 : 2500);
})();
