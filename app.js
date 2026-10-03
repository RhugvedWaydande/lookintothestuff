'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = { video: null, summary: '', qaHistory: [], chatHistory: JSON.parse(sessionStorage.getItem('lts_chat') || '[]') };

/* ---------- Router ---------- */
function route() {
  const r = (location.hash || '#home').slice(1);
  const view = ['home', 'summarize', 'chat', 'support'].includes(r) ? r : 'home';
  $$('.view').forEach((v) => (v.hidden = v.id !== `view-${view}`));
  $$('.nav nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === view));
  if (view === 'chat') { renderChat(); setTimeout(() => $('#chat-input').focus(), 50); }
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', route);

/* ---------- Utils ---------- */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 2200); }

const YT_RE = /^(https?:\/\/)?((www|m|music)\.)?(youtube\.com\/(watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)[A-Za-z0-9_-]{11}/;
const looksLikeYT = (s) => YT_RE.test(s.trim()) || /^[A-Za-z0-9_-]{11}$/.test(s.trim());

async function api(path, body) {
  let r;
  try {
    r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new Error('Network error — check your connection.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status}).`);
  return j;
}

/** Tiny, safe Markdown renderer: escape first, then apply formatting. */
function md(src) {
  const lines = esc(src).split('\n');
  let html = '', list = null;
  const inline = (t) => t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\*\*/g, (_, ts) => tsLink(ts))
    .replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, (_, ts) => tsLink(ts))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const l = raw.trimEnd();
    let m;
    if ((m = l.match(/^#{1,2}\s+(.*)/)) && !l.startsWith('###')) { close(); html += `<h2>${inline(m[1])}</h2>`; }
    else if ((m = l.match(/^#{3,6}\s+(.*)/))) { close(); html += `<h3>${inline(m[1])}</h3>`; }
    else if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
    else if (!l.trim()) close();
    else { close(); html += `<p>${inline(l)}</p>`; }
  }
  close();
  return html;
}
function tsLink(ts) {
  const secs = ts.split(':').map(Number).reduce((a, n) => a * 60 + n, 0);
  return `<a class="ts" data-t="${secs}" href="#" title="Jump to ${ts}">${ts}</a>`;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('.ts');
  if (!a) return;
  e.preventDefault();
  if (state.video) loadPlayer(state.video.videoId, +a.dataset.t, true);
});

/* ---------- Health (retries to ride out free-tier cold starts) ---------- */
(async function health(attempt = 0) {
  const p = $('#status-pill');
  try {
    const h = await fetch('/api/health').then((r) => { if (!r.ok) throw 0; return r.json(); });
    if (h.demo) { p.textContent = '● demo mode'; p.className = 'pill demo'; p.title = 'No GEMINI_API_KEY configured — responses are placeholders'; }
    else { p.textContent = '● AI online'; p.className = 'pill live'; p.title = h.model; }
  } catch {
    p.textContent = attempt < 6 ? '● waking up…' : '● offline';
    if (attempt < 6) setTimeout(() => health(attempt + 1), 5000);
  }
})();

/* ---------- Hero ---------- */
$('#hero-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('#hero-url').value.trim();
  if (!looksLikeYT(url)) { $('#hero-error').textContent = 'Please paste a valid YouTube link (youtube.com/watch, youtu.be, or /shorts).'; return; }
  $('#hero-error').textContent = '';
  $('#sum-url').value = url;
  location.hash = '#summarize';
  setTimeout(() => $('#sum-form').requestSubmit(), 30);
});

/* ---------- Player ---------- */
function loadPlayer(id, start = 0, autoplay = false) {
  const wrap = $('#player-wrap');
  if (!autoplay) {
    // Lightweight facade: thumbnail until the user clicks (faster, privacy-friendly)
    wrap.innerHTML = `<img src="https://i.ytimg.com/vi/${id}/hqdefault.jpg" alt=""><button class="play" aria-label="Play video">▶</button>`;
    $('.play', wrap).onclick = () => loadPlayer(id, 0, true);
    return;
  }
  wrap.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?start=${start}&autoplay=1&rel=0" title="YouTube player" allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen>
}

/* ---------- Summarize ---------- */
$('#sum-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#sum-url').value.trim();
  const length = $('input[name=len]:checked').value;
  const err = $('#sum-error'); err.textContent = '';
  if (!looksLikeYT(url)) { err.textContent = 'Please paste a valid YouTube link (youtube.com/watch, youtu.be, or /shorts).'; return; }
  const btn = $('#sum-btn'); btn.disabled = true; btn.textContent = 'Analysing…';
  try {
    const meta = await api('/api/video/validate', { url });
    const changed = state.video?.videoId !== meta.videoId;
    state.video = { ...meta, url };
    $('#empty-state').hidden = true; $('#workspace').hidden = false;
    $('#v-title').textContent = meta.title || 'YouTube video';
    $('#v-author').textContent = meta.author || '';
    if (changed) { loadPlayer(meta.videoId); resetQA(); }
    $('#summary').innerHTML = `<p class="loading-label">Gemini is watching the video… long videos can take up to a minute.</p>${'<div class="skeleton"></div>'.repeat(6)}`;
    const res = await api('/api/summarize', { url, length, meta: { title: meta.title } });
    state.summary = res.summary;
    $('#summary').innerHTML = md(res.summary);
    if (res.cached) toast('Loaded from cache ⚡');
  } catch (ex) {
    err.textContent = ex.message;
    if (state.video) $('#summary').innerHTML = `<p class="error" style="text-align:left">${esc(ex.message)}</p>`;
  } finally { btn.disabled = false; btn.textContent = 'Summarize'; }
});

$('#copy-btn').onclick = async () => { if (!state.summary) return; await navigator.clipboard?.writeText(state.summary).catch(() => {}); toast('Summary copied'); };
$('#dl-btn').onclick = () => {
  if (!state.summary) return;
  const blob = new Blob([`# ${state.video?.title || 'Summary'}\n${state.video?.url || ''}\n\n${state.summary}`], { type: 'text/markdown' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `summary-${state.video?.videoId || 'video'}.md` });
  a.click(); URL.revokeObjectURL(a.href);
};

/* ---------- Chat rendering shared ---------- */
function addMsg(log, role, text, cls = '') {
  const d = document.createElement('div');
  d.className = `msg ${role} ${cls}`;
  d.innerHTML = role === 'user' ? esc(text) : `<div class="md">${md(text)}</div>`;
  log.appendChild(d); log.scrollTop = log.scrollHeight;
  return d;
}
function typing(log) {
  const d = document.createElement('div'); d.className = 'msg model typing';
  d.innerHTML = '<span></span><span></span><span></span>'; log.appendChild(d); log.scrollTop = log.scrollHeight; return d;
}

/* ---------- Q&A ---------- */
const chipsHTML = $('#qa-log').innerHTML;
function resetQA() { state.qaHistory = []; $('#qa-log').innerHTML = chipsHTML; bindChips(); }
function bindChips() { $$('#qa-log .chip').forEach((c) => (c.onclick = () => { $('#qa-input').value = c.textContent; $('#qa-form').requestSubmit(); })); }
bindChips();
$('#qa-clear').onclick = resetQA;
$('#qa-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#qa-input').value.trim();
  if (!q) return;
  if (!state.video) { toast('Load a video first'); return; }
  const log = $('#qa-log'); $('.chips', log)?.remove();
  $('#qa-input').value = '';
  addMsg(log, 'user', q);
  const t = typing(log);
  try {
    const { answer } = await api('/api/ask', { url: state.video.url, question: q, history: state.qaHistory });
    t.remove(); addMsg(log, 'model', answer);
    state.qaHistory.push({ role: 'user', text: q }, { role: 'model', text: answer });
  } catch (ex) { t.remove(); addMsg(log, 'model', '⚠️ ' + ex.message, 'err'); }
});

/* ---------- Chat ---------- */
const WELCOME = "Hey, I'm **Nova** 👋 I can explain how lookintothestuff works, help you get better summaries, or just chat. What's up?";
function renderChat() {
  const log = $('#chat-log');
  if (log.dataset.rendered) return;
  log.dataset.rendered = '1'; log.innerHTML = '';
  addMsg(log, 'model', WELCOME);
  state.chatHistory.forEach((m) => addMsg(log, m.role, m.text));
}
$('#chat-clear').onclick = () => { state.chatHistory = []; sessionStorage.removeItem('lts_chat'); delete $('#chat-log').dataset.rendered; renderChat(); };
$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#chat-input').value.trim();
  if (!msg) return;
  const log = $('#chat-log'); $('#chat-input').value = '';
  addMsg(log, 'user', msg);
  const t = typing(log);
  try {
    const { reply } = await api('/api/chat', { message: msg, history: state.chatHistory });
    t.remove(); addMsg(log, 'model', reply);
    state.chatHistory.push({ role: 'user', text: msg }, { role: 'model', text: reply });
    state.chatHistory = state.chatHistory.slice(-20);
    sessionStorage.setItem('lts_chat', JSON.stringify(state.chatHistory));
  } catch (ex) { t.remove(); addMsg(log, 'model', '⚠️ ' + ex.message, 'err'); }
});

/* ---------- Support ---------- */
$('#support-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, out = $('#support-msg');
  const data = Object.fromEntries(new FormData(f));
  let ok = true;
  $$('input,textarea', f).forEach((el) => el.classList.remove('invalid'));
  if (!data.name.trim()) { f.name.classList.add('invalid'); ok = false; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) { f.email.classList.add('invalid'); ok = false; }
  if (data.message.trim().length < 10) { f.message.classList.add('invalid'); ok = false; }
  if (!ok) { out.className = 'form-msg bad'; out.textContent = 'Please fix the highlighted fields (message needs 10+ characters).'; return; }
  const btn = $('button[type=submit]', f); btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const r = await api('/api/support', data);
    out.className = 'form-msg ok';
    out.textContent = `✓ Sent! Ticket ${r.ticketId}. We'll reply to ${data.email}.`;
    f.reset();
  } catch (ex) { out.className = 'form-msg bad'; out.textContent = ex.message; }
  finally { btn.disabled = false; btn.textContent = 'Send to support'; }
});

if (state.video === null && location.hash === '#summarize') $('#empty-state').hidden = false;
$('#yr').textContent = new Date().getFullYear();
route();
