# lookintothestuff

**Paste a YouTube link → get an instant AI summary with clickable timestamps → ask the video questions.**

A small, self-hostable web app built on Node + Express and the Google Gemini API. Gemini ingests the video directly from its URL (audio + frames), so there's no download or transcription pipeline to run.

- **Live demo:** https://lookintothestuff.onrender.com
- **Stack:** Node 20+, Express 5, vanilla JS/CSS (no front-end build step), Gemini `generateContent` API
- **Cost to run:** ₹0 on free tiers — Render (hosting), Google AI Studio (Gemini), Brevo (support email)

---

## Features

| Feature | What it does |
|---|---|
| **Summaries** | Three depths — Short, Standard (TL;DR / Key Points / Timeline / Takeaways), Detailed study-notes |
| **Clickable timestamps** | Every `MM:SS` in a summary seeks the embedded player |
| **Ask this video** | Multi-turn Q&A grounded in the video, citing timestamps; says so when the video doesn't cover it |
| **Nova chat** | A separate assistant that helps with the site itself |
| **Support** | A real ticket form → lands in your inbox with `Reply-To` set to the user, plus an auto-acknowledgement |
| **Privacy-friendly player** | `youtube-nocookie.com` embed loads only after a click (thumbnail facade first) |

Built in: server-side API proxy (the Gemini key never reaches the browser), 24 h in-memory summary cache, per-IP rate limits, honeypot, CSP, XSS-safe Markdown rendering, and a demo mode that works with no API key at all.

---

## Quick start

```bash
git clone https://github.com/RhugvedWaydande/lookintothestuff.git
cd lookintothestuff
npm install
cp .env.example .env    # optional — see below
npm start               # http://localhost:3000
```

**No API key? It still runs.** With `GEMINI_API_KEY` unset the server boots in **demo mode**: the UI works end-to-end with clearly-labelled placeholder responses, and the status pill in the nav reads `● demo mode`.

Requirements: Node **20 or newer** (uses the built-in `fetch`).

---

## Configuration

Copy `.env.example` to `.env`. Every value is optional — the app degrades gracefully.

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | for real AI | From [AI Studio](https://aistudio.google.com/apikey). Unset ⇒ demo mode |
| `GEMINI_MODEL` | no | Model name, default `gemini-3.8-flash`. Must exist for your key — verify in the [model list](https://ai.google.dev/gemini-api/docs/models) |
| `SUPPORT_EMAIL` | for support | Where tickets are delivered |
| `SMTP_FROM` | for support | Verified sender address |
| `BREVO_API_KEY` | for support (A) | Brevo HTTPS API — works on hosts that block SMTP |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | for support (B) | Any SMTP provider (VPS/paid hosts; Render's free plan blocks SMTP ports) |
| `FRAME_ANCESTORS` | no | CSP `frame-ancestors` allowlist, comma-separated. Defaults to `'self'` when `NODE_ENV=production`, `*` otherwise |
| `PORT` | no | Default `3000` |

Without an email provider configured, support tickets are **logged to the console instead of sent** — the form still returns a ticket ID, so the flow is testable end-to-end.

---

## Deploy

### Render (what this repo is set up for)

`render.yaml` is a ready-to-use blueprint: `npm install` → `npm start`, health check on `/api/health`, Singapore region.

1. Fork this repo.
2. Render → **New → Blueprint** → pick your fork.
3. Fill in the `sync: false` env vars (`GEMINI_API_KEY`, `BREVO_API_KEY`, `SUPPORT_EMAIL`, `SMTP_FROM`).

See **[LAUNCH.md](LAUNCH.md)** for the full click-by-click walkthrough (no command line needed), including how to get the Gemini key and set up Brevo.

### Vercel / other serverless hosts

This repo is shaped for a long-lived Node process (`app.listen`). Deploying to Vercel requires an `api/` serverless entry point plus a `vercel.json` rewrite — it is **not** a drop-in deploy as-is. A plain VPS or Fly.io works unmodified.

> **Note:** the summary cache and rate-limit counters live in process memory. They reset when the host sleeps or redeploys, and are per-instance. Fine for a single small deployment; swap in Redis if you scale out.

---

## API

All AI routes are proxied — no key is ever sent to the client.

| Route | Body | Returns |
|---|---|---|
| `GET /api/health` | — | `{ ok, demo, model, email }` |
| `POST /api/video/validate` | `{ url }` | `{ videoId, title, author, thumbnail }` — confirms the video exists and is public via oEmbed |
| `POST /api/summarize` | `{ url, length }` | `{ videoId, summary }` — `length`: `short` \| `standard` \| `detailed` |
| `POST /api/ask` | `{ url, question, history }` | `{ answer }` |
| `POST /api/chat` | `{ message, history }` | `{ reply }` |
| `POST /api/support` | `{ name, email, category, message, videoUrl }` | `{ ok, ticketId }` |

Rate limits: **15 req/min** on AI routes, **5 req/hour** on support. Errors are JSON `{ error, code }`.

---

## Project structure

```
server.js        Express server: Gemini proxy, validation, cache, rate limits, support email
index.html       Single page: Home / Summarize / Chat / Support views (hash router)
app.js           Front-end: router, Markdown renderer, player, chat, form handling
styles.css       All styling — glassmorphism dark theme, responsive, reduced-motion aware
privacy.html     Privacy policy
terms.html       Terms of use
render.yaml      Render blueprint
LAUNCH.md        Non-technical deployment guide
BLUEPRINT.md     Architecture and design rationale
```

No build step, no bundler, no framework. `index.html` loads `styles.css` and `app.js` directly.

---

## Notes on how it behaves

- **Validation is server-side too.** The client regex is a convenience; the server re-parses the URL, extracts the 11-character video ID, and builds the `fileUri` itself — so it can never be pointed at an arbitrary URL.
- **Markdown is escaped before formatting.** AI output is HTML-escaped first, then a small renderer applies headings, lists, bold/italic, code and timestamp links.
- **Long videos may fail.** Gemini's URL ingestion has limits and the request aborts after 120 s. The UI surfaces this as "could not be analysed" rather than hanging.

---

## License

[MIT](LICENSE) © rhugved

Not affiliated with YouTube or Google. Videos belong to their creators.
