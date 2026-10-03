# lookintothestuff — Product & Technical Blueprint

> AI-powered YouTube summaries and Q&A, built on the Gemini API.
> A working prototype is in this folder (`server.js` + `public/`). This document covers the full production design.

---

## 1. Website Structure (Sitemap)

```
lookintothestuff.com
├── /  (Home)
│   ├── Hero: tagline + URL bar ("Paste link → Summarize")
│   ├── Feature cards: Summaries · Ask the video · Chat · Human support
│   └── 3-step "How it works"
│
├── /summarize  (Main workspace)
│   ├── URL bar + length selector (Short / Standard / Detailed)
│   ├── Left column
│   │   ├── Video player (thumbnail first, loads the real player on click)
│   │   ├── Title / channel
│   │   └── Summary panel (TL;DR, Key points, clickable timestamps, Takeaways)
│   │       └── Actions: Copy · Download .md  (future: Share link, PDF)
│   └── Right column: "Ask this video" Q&A
│       ├── Suggested question chips
│       └── Message thread + composer
│
├── /chat  (Nova, the assistant)
│   ├── Full-page chat with the Gemini bot
│   └── "Need a human?" → /support
│
├── /support
│   ├── Intro + promises (ticket ID, email reply, privacy)
│   └── Form: name, email, category, related video, message (+ hidden honeypot field)
│
├── /history        (phase 2, signed-in users: past summaries)
├── /account        (phase 2: profile, usage, plan)
├── /privacy  /terms
└── /api/*          (backend, see §3)
```

**Navigation:** a sticky glass nav bar with 4 items (Home, Summarize, Chat, Support) and an AI status badge. The Summarize screen is the core of the product. You can reach it from anywhere in one click.

---

## 2. Technology Stack

| Layer | Prototype (in this repo) | Recommended for production |
|---|---|---|
| Front-end | Plain HTML + CSS + JS, hash-based page switching | **Next.js (App Router) + TypeScript + Tailwind CSS**, Framer Motion for animation, shadcn/ui for accessible components |
| Back-end | **Node.js + Express** | Next.js Route Handlers or a separate Express/Fastify service; Zod for input checks |
| AI | Gemini REST `generateContent` (`gemini-2.5-flash`, set via env) | Official `@google/genai` SDK, streaming responses, context caching |
| Database | In-memory cache only | **PostgreSQL** (Supabase or Neon) + Prisma ORM |
| Cache / rate limiting | `express-rate-limit` + in-memory Map | **Redis (Upstash)** for shared caching and rate limits |
| Auth (phase 2) | — | Auth.js / Clerk / Supabase Auth (Google sign-in) |
| Email | **Nodemailer over SMTP** | Resend / SendGrid / AWS SES with SPF, DKIM and DMARC on your domain |
| Security | Helmet (CSP), honeypot field, input checks | + Cloudflare Turnstile CAPTCHA, WAF, secret manager |
| Hosting | Any Node host | Vercel (front-end) + Render/Fly.io/Cloud Run (API), Cloudflare in front |
| Monitoring | console | Sentry (errors), PostHog (analytics), token-usage dashboard |

**Design system ("futuristic but simple"):**
- Dark base `#05060f` with a faint fading grid and two slow-moving blurred light blobs (orbs).
- Accent gradient: cyan `#00f0ff` → violet `#a855f7` → pink `#ff3cac`, used only on calls to action and highlights.
- Frosted-glass panels (`backdrop-filter: blur`) with 1px borders that glow on focus.
- Micro-interactions: a scan line on the empty state, shimmering loading placeholders, a typing indicator, glowing focus rings.
- Simplicity rules: one main action per screen, at most 4 nav items, plain-language error messages. Animations switch off when the user's system has "reduce motion" turned on (`prefers-reduced-motion`).

---

## 3. API Integration Plan (Gemini)

### 3.1 Key idea: Gemini watches YouTube natively
The Gemini API accepts a **public YouTube URL directly** as a `fileData` part. The model processes both the audio and video frames, so you don't need to download videos or scrape transcripts:

```json
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent
Header: x-goog-api-key: $GEMINI_API_KEY
{
  "systemInstruction": { "parts": [{ "text": "You are a precise video summariser..." }] },
  "contents": [{
    "role": "user",
    "parts": [
      { "fileData": { "fileUri": "https://www.youtube.com/watch?v=VIDEO_ID", "mimeType": "video/*" } },
      { "text": "Summarise this video. Respond in Markdown with: TL;DR, Key Points, Timeline (**MM:SS**), Takeaways" }
    ]
  }],
  "generationConfig": { "temperature": 0.4, "maxOutputTokens": 2048 }
}
```

**Fallback path** (for long, unsupported or restricted videos): fetch the transcript server-side (YouTube Data API captions or a transcript service), split it into chunks, summarise each chunk, then combine the chunk summaries into one ("map-reduce") using text-only Gemini calls. This is also cheaper.

### 3.2 Endpoints (built in `server.js`)

| Endpoint | Purpose | Gemini usage |
|---|---|---|
| `GET /api/health` | Status, model name, demo flag | — |
| `POST /api/video/validate` | Parse URL → 11-character ID, check the video via YouTube oEmbed (exists / public / title / thumbnail) | none (free) |
| `POST /api/summarize` `{url, length}` | Summary in 3 lengths, cached per `(videoId, length)` | video + prompt |
| `POST /api/ask` `{url, question, history[]}` | Q&A about the video, multi-turn | video in the first turn + last 10 turns |
| `POST /api/chat` `{message, history[]}` | Nova assistant (site help + general questions) | text only |
| `POST /api/support` | Send the ticket by email | — |

### 3.3 Prompting
- **Summaries:** a fixed Markdown layout, so the UI can turn `**MM:SS**` into clickable buttons that jump the player to that moment.
- **Q&A system instruction:** "Answer strictly from the video; cite timestamps; if the answer isn't in the video, say so." This reduces made-up answers.
- **Chat system instruction:** a site guide persona ("Nova") that sends account and bug problems to Support.
- The user only controls the question text. Prompts and system instructions always come from the server, which limits prompt-injection risk.

### 3.4 Error handling (built)

| Situation | Detection | User sees |
|---|---|---|
| Not a YouTube link / malformed | Format check in the browser **and** on the server | "That doesn't look like a valid YouTube link." |
| Deleted video | oEmbed 404 | "Video not found. It may have been deleted." |
| Private / non-embeddable | oEmbed 401/403 | "This video is private or not embeddable…" |
| Too long / age- or region-restricted | Gemini 400 mentioning video/file/token | "This video could not be analysed…" (later: try the transcript fallback) |
| Quota / rate limit hit | Gemini 429 | Automatic retry with increasing waits (1s, 2s), then "AI quota temporarily exhausted" |
| Gemini outage / 5xx | Status ≥ 500 | Retry, then "AI service is unavailable right now." |
| Timeout | 120s abort | "Took too long — try a shorter video." |
| Safety block / empty response | No candidates / empty text | Clear message, no crash |
| Too many requests from one user | express-rate-limit (15/min AI, 5/h support) | "Too many requests. Please wait a minute." |
| Network failure in the browser | `fetch` throws | "Network error — check your connection." |
| No API key configured | Server starts in **demo mode** | Placeholder responses and a yellow "demo mode" badge |

### 3.5 Usage limits & cost control
- **Token cost of video:** at default resolution, Gemini uses roughly **~300 tokens per second of video** (frames sampled at 1 frame per second, plus audio), so about 1M tokens per hour. Low media resolution cuts this to about 100 tokens/s. *Check current figures in Google's docs before launch.*
- The free tier has request-per-minute and per-day caps, plus a daily cap on YouTube video processing. Paid tiers raise these limits. Prices change, so check the current Gemini pricing page.
- Ways to keep costs down:
  1. **Caching:** summaries are keyed by `videoId+length` (24h in-memory now; Redis/Postgres in production). Popular videos are summarised once.
  2. **Use the summary as context for Q&A:** for most questions, answering from the stored summary and transcript (text) is about 10–50× cheaper than sending the video again. Only send the full video when the answer needs visual detail.
  3. **Context caching** (Gemini cached content) for long videos that get many questions.
  4. Set `mediaResolution: LOW` for videos over about 20 minutes. Cap length (for example 60 minutes on free accounts) using the YouTube Data API `contentDetails.duration`.
  5. Pick the model per task: Flash (or Flash-Lite) by default, Pro only for "Detailed" on paid plans.
  6. Per-user daily limits (for example 5 summaries a day for guests, 50 for signed-in users) stored in Redis, and log `usageMetadata.totalTokenCount` for every request.
  7. Spending alerts in Google Cloud Billing.

---

## 4. Database Design (PostgreSQL)

```sql
-- Users (optional; guests are identified by an anonymous session_id cookie)
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT UNIQUE NOT NULL,
  name          TEXT,
  plan          TEXT NOT NULL DEFAULT 'free',          -- free | pro
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per YouTube video ever seen (shared cache)
CREATE TABLE videos (
  id            TEXT PRIMARY KEY,                       -- 11-char YouTube ID
  title         TEXT,
  channel       TEXT,
  duration_sec  INT,
  thumbnail_url TEXT,
  transcript    TEXT,                                   -- optional fallback
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cached AI summaries (shared across users)
CREATE TABLE summaries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id      TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  length        TEXT NOT NULL CHECK (length IN ('short','standard','detailed')),
  model         TEXT NOT NULL,
  content_md    TEXT NOT NULL,
  tokens_used   INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (video_id, length, model)
);

-- Conversations: Q&A about a video, or general chat with Nova
CREATE TABLE conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  session_id    TEXT,                                   -- for guests
  type          TEXT NOT NULL CHECK (type IN ('video_qa','chat')),
  video_id      TEXT REFERENCES videos(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','model')),
  content         TEXT NOT NULL,
  tokens_used     INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON messages (conversation_id, created_at);

-- Support tickets (kept as a record even though email is the main channel)
CREATE TABLE support_tickets (
  id            TEXT PRIMARY KEY,                       -- e.g. LTS-3F9A1C
  user_id       UUID REFERENCES users(id),
  name          TEXT NOT NULL,
  email         CITEXT NOT NULL,
  category      TEXT NOT NULL,
  video_url     TEXT,
  message       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',           -- open | replied | closed
  email_msg_id  TEXT,                                   -- SMTP Message-ID, links email replies to the ticket
  ip_hash       TEXT,                                   -- SHA-256 of IP + salt, never the raw IP
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Usage tracking for quotas and cost reporting
CREATE TABLE usage_events (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID REFERENCES users(id),
  session_id    TEXT,
  action        TEXT NOT NULL,                          -- summarize | ask | chat
  video_id      TEXT,
  tokens        INT,
  cache_hit     BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON usage_events (user_id, created_at);
```

**Data retention:** delete guest conversations after 30 days and anonymise support tickets after 1 year (a cron job). Users can delete their history from /account.

---

## 5. User Flow

```
            ┌──────────┐  paste link   ┌──────────────┐ valid? ─no─► inline error
 Landing ──►│  Hero    │──────────────►│ /summarize   │
            └──────────┘               │ validate URL │
                                       └──────┬───────┘
                                              │ yes: show player + title,
                                              │ loading placeholders
                                              ▼
                                   ┌─────────────────────┐   cache hit → instant ⚡
                                   │ Summary rendered    │
                                   │ (clickable times)   │──► Copy / Download
                                   └─────────┬───────────┘
                                             ▼
                                   ┌─────────────────────┐
                                   │ Ask this video      │◄─┐ follow-ups keep context
                                   │ chips / free text   │──┘
                                   └─────────┬───────────┘
                                             │ need general help?
                                             ▼
                          ┌──────────────┐  still stuck  ┌──────────────────┐
                          │ /chat (Nova) │──────────────►│ /support form    │
                          └──────────────┘               │ → ticket ID       │
                                                         │ → email to team   │
                                                         │ → confirmation    │
                                                         │   email to user   │
                                                         └──────────────────┘
```

1. **Arrive:** the Home page explains the product in one line. The user pastes a link in the hero bar.
2. **Validate:** the browser checks the format right away, then the server confirms the video exists and is public, and returns the title and thumbnail.
3. **Summarize:** the workspace opens: player on the left, loading placeholders and "Gemini is watching the video…". The summary appears with clickable timestamps. Switching length re-runs it (cached results return instantly).
4. **Ask:** the user taps a suggested chip or types a question. Answers cite timestamps, and follow-ups keep the earlier conversation as context.
5. **Chat:** for help with the site or general questions, Nova is one click away. Chat history lasts for the browser session.
6. **Support:** the form sends a ticket. The user sees "Ticket LTS-XXXX" and gets a confirmation email. The team replies straight from their inbox.

---

## 6. Support System Implementation

**Flow (built in the prototype):**
1. The front-end checks the fields (name, valid email, message of 10+ characters). A hidden **honeypot** field quietly drops spam bots.
2. `POST /api/support` checks everything again on the server, trims lengths, and limits each IP to **5 requests per hour**.
3. The server creates a ticket ID such as `LTS-3F9A1C`.
4. **Nodemailer** sends:
   - **To your inbox** (`SUPPORT_EMAIL`): subject `[LTS-3F9A1C] BUG — Jane`, HTML-escaped body, and **`Reply-To: user's email`**. Hitting *Reply* in Gmail or Outlook emails the user directly, which gives you a direct conversation over email.
   - **To the user:** an automatic confirmation with the ticket ID, `Reply-To: SUPPORT_EMAIL`.
5. If SMTP isn't configured yet, the ticket is logged on the server so nothing is lost while you develop.

**Configuration (`.env`):**
```
SMTP_HOST=smtp.gmail.com     SMTP_PORT=465
SMTP_USER=you@gmail.com      SMTP_PASS=<16-char Google App Password>
SMTP_FROM=support@lookintothestuff.com
SUPPORT_EMAIL=you@yourdomain.com
```
For production, use a transactional email provider (Resend, SendGrid, SES) with **SPF, DKIM and DMARC** set up on your domain so emails don't land in spam.

**Phase 2 — two-way conversation on the website:** set up an inbound-email webhook (Postmark/SendGrid Inbound Parse, or the Gmail API). Replies containing `[LTS-XXXX]` are matched to `support_tickets` and shown in a "My tickets" thread on the site. You could also forward tickets to Slack or Discord through a webhook for team alerts.

---

## 7. Security Checklist

- **API key only on the server.** The browser talks to `/api/*`; the Gemini key lives in env vars or a secret manager and is never sent to the client.
- **Input checks on both sides.** YouTube IDs must match `^[A-Za-z0-9_-]{11}$`. The server builds the `fileUri` itself from the ID, so users can't make it fetch arbitrary URLs (no server-side request forgery). Request bodies are limited to 32 KB and text fields are length-capped.
- **XSS protection:** Markdown from the AI is HTML-escaped *before* formatting is applied. A strict CSP (Helmet) allows scripts only from this site and embeds only from `youtube-nocookie.com`.
- **Email header-injection protection:** line breaks are removed from the subject, the email address is checked, and the message body is HTML-escaped.
- **Abuse protection:** rate limits on all AI and support routes, a honeypot field, and Cloudflare Turnstile recommended for production.
- **Privacy:** the privacy-enhanced YouTube embed (`youtube-nocookie.com`) loads only after a click, IPs are stored hashed, data is deleted on a schedule, and the privacy policy says what is sent to Google's Gemini API.
- **HTTPS everywhere, secure cookies** (`HttpOnly; Secure; SameSite=Lax`) once accounts exist, and regular dependency audits (`npm audit`, Dependabot).

---

## 8. Running the Prototype

```bash
cd lookintothestuff
npm install
cp .env.example .env      # add GEMINI_API_KEY (and SMTP settings for support email)
npm start                 # http://localhost:3000
```
Without a key, the app runs in **demo mode** with placeholder AI responses, so you can still try the full UI.

## 9. Roadmap
- **v1.1:** streaming answers (`streamGenerateContent` via server-sent events), transcript fallback, PDF export, shareable summary links.
- **v1.2:** accounts, history, a usage dashboard, multiple languages ("summarise in Hindi/Marathi").
- **v2:** a browser extension (summarise from the YouTube page itself), playlist summaries, comparing two videos, a Pro plan with Stripe/Razorpay billing.
