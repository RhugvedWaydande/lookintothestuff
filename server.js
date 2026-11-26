/**
 * lookintothestuff — backend
 * Express server that proxies all AI calls to the Gemini API (the API key never reaches the browser),
 * validates YouTube links, caches summaries, rate-limits requests, and forwards support tickets to email.
 */
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const DEMO_MODE = !GEMINI_API_KEY; // no key → canned responses so the UI is still explorable
const GEMINI_URL = (m) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

// Who may iframe the site. Locked to the site itself in production; open elsewhere so
// local/preview tooling can embed it. Override with FRAME_ANCESTORS="'self',https://a.com".
const FRAME_ANCESTORS = (
  process.env.FRAME_ANCESTORS || (process.env.NODE_ENV === 'production' ? "'self'" : '*')
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https://i.ytimg.com'],
        frameSrc: ['https://www.youtube-nocookie.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: FRAME_ANCESTORS,
      },
    },
    // X-Frame-Options is intentionally off; frame-ancestors above is the single source of truth,
    // because X-Frame-Options has no way to express an allowlist and would override it.
    frameguard: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);
app.use(express.json({ limit: '32kb' }));
// Front-end files are served from the repo root (see the routes below) — there is no public/ dir.
['index.html', 'styles.css', 'app.js', 'privacy.html', 'terms.html', 'robots.txt'].forEach((f) =>
  app.get(f === 'index.html' ? ['/', '/index.html'] : '/' + f, (req, res) =>
    res.sendFile(path.join(__dirname, f))
  )
);
/* ---------------- Rate limits (protect Gemini quota + email inbox) ---------------- */
const aiLimiter = rateLimit({ windowMs: 60_000, max: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a minute and try again.', code: 'RATE_LIMITED' } });
const supportLimiter = rateLimit({ windowMs: 60 * 60_000, max: 5,
  message: { error: 'Support request limit reached. Try again in an hour.', code: 'RATE_LIMITED' } });

/* ---------------- Helpers ---------------- */
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
function extractVideoId(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (YT_ID_RE.test(s)) return s;
  let u;
  try { u = new URL(s.startsWith('http') ? s : `https://${s}`); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
      if (m) id = m[2];
    }
  }
  return id && YT_ID_RE.test(id) ? id : null;
}

async function fetchVideoMeta(id) {
  // oEmbed: free, keyless, and confirms the video exists + is public/embeddable
  const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${id}`);
  if (r.status === 404 || r.status === 400) return null;
  if (r.status === 401 || r.status === 403) return { private: true };
  if (!r.ok) throw new Error('oEmbed unavailable');
  const j = await r.json();
  return { title: j.title, author: j.author_name, thumbnail: j.thumbnail_url };
}

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** Single entry point to Gemini, with timeout + retry on 429/5xx. */
async function callGemini({ contents, systemInstruction, maxTokens = 2048, retries = 3 }) {
  const body = {
    contents,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: maxTokens + 4096, // headroom: "thinking" tokens count toward the output limit
      ...(/^gemini-3/.test(GEMINI_MODEL) && { thinkingConfig: { thinkingLevel: 'low' } }),
    },
    ...(systemInstruction && { systemInstruction: { parts: [{ text: systemInstruction }] } }),
  };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const r = await fetch(GEMINI_URL(GEMINI_MODEL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        const cand = j.candidates?.[0];
        if (!cand) throw new ApiError(422, 'BLOCKED', 'The AI declined to process this content (safety filter).');
        const text = (cand.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
        if (!text) throw new ApiError(422, 'EMPTY', 'The AI returned an empty response. Try again.');
        return { text, usage: j.usageMetadata };
      }
      const msg = (j.error?.message || '').replace(/\s+/g, ' ').slice(0, 300);
      if ((r.status === 429 || r.status >= 500) && attempt < retries) {
        console.warn(`[gemini] ${r.status} (attempt ${attempt + 1}/${retries + 1}), retrying: ${msg || 'no message'}`);
        await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
        continue;
      }
      // Always log why upstream failed — the browser gets a friendly line, the host log gets the truth.
      console.error(`[gemini] upstream ${r.status} · model ${GEMINI_MODEL} · ${msg || '(no message)'}`);
      if (r.status === 404) throw new ApiError(502, 'AI_CONFIG', `AI model "${GEMINI_MODEL}" not found — update GEMINI_MODEL.`);
      if (r.status === 429) throw new ApiError(429, 'QUOTA', 'AI quota temporarily exhausted. Please try again shortly.');
      if (r.status === 400 && /video|file|uri|duration|token/i.test(msg))
        throw new ApiError(422, 'VIDEO_UNPROCESSABLE', 'This video could not be analysed (it may be too long, private, age-restricted or region-locked).');
      if ((r.status === 400 || r.status === 401) && /api[\s_-]?key|credential|unauthori[sz]ed|permission/i.test(msg))
        throw new ApiError(502, 'AI_CONFIG', 'The AI service rejected our API key — check GEMINI_API_KEY in the host environment.');
      if (r.status === 401) throw new ApiError(502, 'AI_CONFIG', 'The AI service rejected our API key (401) — check GEMINI_API_KEY.');
      if (r.status === 400 || r.status === 403) throw new ApiError(502, 'AI_CONFIG', 'AI service rejected the request. ' + msg);
      throw new ApiError(502, 'AI_DOWN', `AI service is unavailable right now (Gemini returned ${r.status}${msg ? `: ${msg}` : ''}).`);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (attempt < retries) continue;
      throw new ApiError(504, 'AI_TIMEOUT', 'The AI took too long to respond. Long videos may time out — try a shorter one.');
    } finally { clearTimeout(t); }
  }
}

const videoPart = (id) => ({ fileData: { fileUri: `https://www.youtube.com/watch?v=${id}`, mimeType: 'video/*' } });

/* ---------------- In-memory cache (swap for Redis/Postgres in production) ---------------- */
const cache = new Map(); // key -> {value, exp}
const CACHE_TTL = 24 * 3600_000;
function cacheGet(k) { const e = cache.get(k); if (!e || e.exp < Date.now()) { cache.delete(k); return null; } return e.value; }
function cacheSet(k, v) { if (cache.size > 500) cache.delete(cache.keys().next().value); cache.set(k, { value: v, exp: Date.now() + CACHE_TTL }); }

const SUMMARY_PROMPTS = {
  short: 'Summarise this video in 3-5 crisp bullet points.',
  standard:
    'Summarise this video. Respond in Markdown with these sections:\n## TL;DR\n(two sentences)\n## Key Points\n(5-8 bullets)\n## Timeline\n(bullets of the form **MM:SS** — topic)\n## Takeaways\n(3 bullets)',
  detailed:
    'Produce a detailed study-notes style summary of this video in Markdown: TL;DR, section-by-section breakdown with **MM:SS** timestamps, important definitions, notable quotes, and actionable takeaways.',
};

/* ---------------- Demo responses ---------------- */
const demo = {
  summary: (meta) => `## TL;DR\n*Demo mode — no GEMINI_API_KEY set.* This is a placeholder summary for **${meta?.title || 'the video'}**. Add your key to \`.env\` to get real AI summaries.\n\n## Key Points\n- The video link was validated and metadata fetched from YouTube.\n- In live mode, Gemini watches the video (audio + frames) directly from its URL.\n- Summaries are cached for 24h, so repeat requests cost nothing.\n- Three lengths are available: Short, Standard, Detailed.\n\n## Timeline\n- **00:00** — Introduction\n- **02:15** — Main concept\n- **07:40** — Wrap-up\n\n## Takeaways\n- Set \`GEMINI_API_KEY\` to go live.\n- Ask follow-up questions in the Q&A panel.\n- Use Support if anything breaks.`,
  answer: (q) => `*(Demo mode)* You asked: “${q}”. With a Gemini API key configured, I would answer this using the video's actual content, citing timestamps like **03:12**.`,
  chat: () => `*(Demo mode)* Hi! I'm the lookintothestuff assistant. Paste a YouTube link on the **Summarize** tab, or set a \`GEMINI_API_KEY\` so I can chat for real.`,
};

/* ---------------- Routes ---------------- */
// ?probe=1 makes a tiny live call to Gemini so you can see the real upstream status
// (bad key, wrong model, quota, outage) instead of guessing from the UI's friendly error.
app.get('/api/health', aiLimiter, async (req, res) => {
  const base = { ok: true, demo: DEMO_MODE, model: GEMINI_MODEL, email: EMAIL_PROVIDER };
  if (req.query.probe !== '1') return res.json(base);
  if (DEMO_MODE) return res.json({ ...base, probe: { status: 'skipped', reason: 'no GEMINI_API_KEY configured' } });
  try {
    const { text } = await callGemini({
      contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
      maxTokens: 8,
      retries: 0,
    });
    res.json({ ...base, probe: { status: 'ok', reply: text.slice(0, 40) } });
  } catch (e) {
    res.json({ ...base, ok: false, probe: { status: 'error', code: e.code || 'UNKNOWN', message: e.message } });
  }
});

app.post('/api/video/validate', aiLimiter, async (req, res, next) => {
  try {
    const id = extractVideoId(req.body?.url);
    if (!id) throw new ApiError(400, 'INVALID_URL', "That doesn't look like a valid YouTube link.");
    let meta;
    try { meta = await fetchVideoMeta(id); } catch { meta = { title: 'YouTube video', author: '', thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }; }
    if (!meta) throw new ApiError(404, 'NOT_FOUND', 'Video not found. It may have been deleted.');
    if (meta.private) throw new ApiError(403, 'PRIVATE', 'This video is private or not embeddable, so it cannot be analysed.');
    res.json({ videoId: id, ...meta });
  } catch (e) { next(e); }
});

app.post('/api/summarize', aiLimiter, async (req, res, next) => {
  try {
    const id = extractVideoId(req.body?.url);
    if (!id) throw new ApiError(400, 'INVALID_URL', "That doesn't look like a valid YouTube link.");
    const length = SUMMARY_PROMPTS[req.body?.length] ? req.body.length : 'standard';
    const key = `sum:${id}:${length}`;
    const hit = cacheGet(key);
    if (hit) return res.json({ ...hit, cached: true });
    if (DEMO_MODE) return res.json({ videoId: id, summary: demo.summary(req.body?.meta), demo: true });
    const { text, usage } = await callGemini({
      contents: [{ role: 'user', parts: [videoPart(id), { text: SUMMARY_PROMPTS[length] }] }],
      systemInstruction: 'You are a precise video summariser. Only state what is in the video. If the video has no meaningful content, say so.',
      maxTokens: length === 'detailed' ? 4096 : 2048,
    });
    const out = { videoId: id, summary: text, tokens: usage?.totalTokenCount };
    cacheSet(key, out);
    res.json(out);
  } catch (e) { next(e); }
});

const sanitizeHistory = (h) =>
  (Array.isArray(h) ? h : []).slice(-10)
    .filter((m) => m && (m.role === 'user' || m.role === 'model') && typeof m.text === 'string')
    .map((m) => ({ role: m.role, parts: [{ text: m.text.slice(0, 4000) }] }));

app.post('/api/ask', aiLimiter, async (req, res, next) => {
  try {
    const id = extractVideoId(req.body?.url);
    const q = (req.body?.question || '').toString().trim().slice(0, 1000);
    if (!id) throw new ApiError(400, 'INVALID_URL', 'Load a valid YouTube video first.');
    if (!q) throw new ApiError(400, 'EMPTY_QUESTION', 'Please type a question.');
    if (DEMO_MODE) return res.json({ answer: demo.answer(q), demo: true });
    const history = sanitizeHistory(req.body?.history);
    // Video is attached to the first turn so the model has context for every follow-up.
    const contents = [
      { role: 'user', parts: [videoPart(id), { text: 'This is the video we will discuss.' }] },
      { role: 'model', parts: [{ text: 'Understood. Ask me anything about it.' }] },
      ...history,
      { role: 'user', parts: [{ text: q }] },
    ];
    const { text } = await callGemini({
      contents,
      systemInstruction:
        'Answer questions strictly about the provided YouTube video. Cite timestamps as **MM:SS** where relevant. If the answer is not in the video, say so clearly instead of guessing. Use concise Markdown.',
    });
    res.json({ answer: text });
  } catch (e) { next(e); }
});

app.post('/api/chat', aiLimiter, async (req, res, next) => {
  try {
    const msg = (req.body?.message || '').toString().trim().slice(0, 2000);
    if (!msg) throw new ApiError(400, 'EMPTY', 'Please type a message.');
    if (DEMO_MODE) return res.json({ reply: demo.chat(), demo: true });
    const { text } = await callGemini({
      contents: [...sanitizeHistory(req.body?.history), { role: 'user', parts: [{ text: msg }] }],
      systemInstruction:
        'You are Nova, the friendly assistant for "lookintothestuff", a website that summarises YouTube videos and answers questions about them. ' +
        'Help users with the site (Summarize tab: paste link → choose length → get summary; Ask panel: question the video; Support tab: email the team) and general questions. Be concise and use Markdown. ' +
        'If a user has an account/billing/bug problem, suggest the Support tab.',
      maxTokens: 1024,
    });
    res.json({ reply: text });
  } catch (e) { next(e); }
});

/* ---------------- Support → email ---------------- */
// Email providers: Brevo HTTPS API (works on hosts that block SMTP, e.g. Render free) → SMTP → log-only.
const transporter = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10_000,
    })
  : null;
const EMAIL_PROVIDER = process.env.BREVO_API_KEY ? 'brevo' : transporter ? 'smtp' : 'none';
const FROM_EMAIL = process.env.SMTP_FROM || process.env.SMTP_USER || process.env.SUPPORT_EMAIL;
const FROM_NAME = 'lookintothestuff Support';

/** sendEmail({to, toName, replyTo, replyToName, subject, html, text}) */
async function sendEmail(m) {
  if (EMAIL_PROVIDER === 'brevo') {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: FROM_NAME, email: FROM_EMAIL },
        to: [{ email: m.to, ...(m.toName && { name: m.toName }) }],
        replyTo: { email: m.replyTo, ...(m.replyToName && { name: m.replyToName }) },
        subject: m.subject, htmlContent: m.html || `<pre>${esc(m.text)}</pre>`, textContent: m.text,
      }),
    });
    if (!r.ok) throw new Error(`Brevo ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return;
  }
  if (EMAIL_PROVIDER === 'smtp') {
    await transporter.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`, to: m.to,
      replyTo: m.replyToName ? `"${m.replyToName.replace(/"/g, '')}" <${m.replyTo}>` : m.replyTo,
      subject: m.subject, html: m.html, text: m.text,
    });
    return;
  }
  throw new Error('NO_PROVIDER');
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;

app.post('/api/support', supportLimiter, async (req, res, next) => {
  try {
    const { name = '', email = '', category = 'general', message = '', videoUrl = '', website = '' } = req.body || {};
    if (website) return res.json({ ok: true, ticketId: 'LTS-000000' }); // honeypot: silently drop bots
    const n = String(name).trim().slice(0, 100), em = String(email).trim().slice(0, 200), m = String(message).trim().slice(0, 5000);
    const cat = ['general', 'bug', 'billing', 'feature', 'other'].includes(category) ? category : 'general';
    if (!n || !EMAIL_RE.test(em) || m.length < 10)
      throw new ApiError(400, 'INVALID_FORM', 'Please provide your name, a valid email and a message of at least 10 characters.');
    const ticketId = 'LTS-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const subject = `[${ticketId}] ${cat.toUpperCase()} — ${n}`.replace(/[\r\n]/g, ' ');
    const html = `<h2>New support ticket ${ticketId}</h2><p><b>From:</b> ${esc(n)} &lt;${esc(em)}&gt;<br><b>Category:</b> ${esc(cat)}<br>
      <b>Video:</b> ${esc(String(videoUrl).slice(0, 300)) || '—'}<br><b>IP:</b> ${esc(req.ip)}</p><pre style="white-space:pre-wrap;font-family:inherit">${esc(m)}</pre>
      <p style="color:#888">Reply directly to this email to respond to the user.</p>`;
    const text = `${ticketId}\nFrom: ${n} <${em}>\nCategory: ${cat}\nVideo: ${videoUrl}\n\n${m}`;
    if (EMAIL_PROVIDER === 'none' || !process.env.SUPPORT_EMAIL) {
      console.log('[support] email not configured — ticket logged only:', { ticketId, n, em, cat, m });
      return res.json({ ok: true, ticketId, note: 'Email not configured; ticket logged on server.' });
    }
    try {
      // Reply-To = the user, so hitting "Reply" in your inbox emails them directly
      await sendEmail({ to: process.env.SUPPORT_EMAIL, replyTo: em, replyToName: n, subject, html, text });
    } catch (e) {
      console.error('[support] delivery failed', ticketId, e.message, { n, em, cat, m });
      throw new ApiError(502, 'EMAIL_FAILED', 'We could not send your message right now. Please try again in a few minutes.');
    }
    // Auto-acknowledgement to the user (non-fatal)
    sendEmail({
      to: em, toName: n, replyTo: process.env.SUPPORT_EMAIL, subject: `We received your request [${ticketId}]`,
      text: `Hi ${n},\n\nThanks for reaching out. Your ticket ID is ${ticketId}. Our team will reply to this email address soon.\n\n— lookintothestuff`,
      html: `<p>Hi ${esc(n)},</p><p>Thanks for reaching out. Your ticket ID is <b>${ticketId}</b>. Our team will reply to this email address soon.</p><p>— lookintothestuff</p>`,
    }).catch((e) => console.warn('[support] ack failed', e.message));
    res.json({ ok: true, ticketId });
  } catch (e) { next(e); }
});

/* ---------------- Error handler ---------------- */
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' }));
app.use((err, _req, res, _next) => {
  if (!(err instanceof ApiError)) console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err instanceof ApiError ? err.message : 'Something went wrong on our side.', code: err.code || 'SERVER_ERROR' });
});

app.listen(PORT, '0.0.0.0', () =>
  console.log(`lookintothestuff running on :${PORT} ${DEMO_MODE ? '(DEMO MODE — set GEMINI_API_KEY)' : `(model ${GEMINI_MODEL})`} · email: ${EMAIL_PROVIDER}`)
);
