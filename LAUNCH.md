# 🚀 Launch Guide — lookintothestuff

**Goal:** get the site live at `https://lookintothestuff.onrender.com`, free and without the command line.
**Time:** about 30–40 minutes. **Cost:** ₹0.

| Piece | Service | Free allowance |
|---|---|---|
| Hosting | **Render** (Singapore region, closest to India) | 1 always-available web service (sleeps when idle) |
| AI | **Google Gemini API** (AI Studio) | Free tier with daily request limits |
| Support email | **Brevo** (sends over HTTPS) | 300 emails/day |
| Code storage | **GitHub** | Free |

> ⚠️ **Why Brevo instead of Gmail SMTP?** Since September 2025, Render's free plan blocks outgoing SMTP email (ports 25/465/587). The site now sends email through Brevo's HTTPS API, which still works on the free plan.

---

## Step 0 — Download the project
1. In this workspace, download **`lookintothestuff-upload.zip`**.
2. Right-click → **Extract All** (Windows) or double-click (Mac). You'll get a folder containing `server.js`, `package.json`, `public/`, and other files.

---

## Step 1 — Get your Gemini API key (5 min)
1. Go to **https://aistudio.google.com/apikey** and sign in with your Google account.
2. Click **Create API key** → choose or create a project → **copy the key** (starts with `AIza…`).
3. Paste it into a private note for now. **Never share it or upload it to GitHub.**

💡 Free-tier note: Google may use free-tier inputs to improve its products (the Privacy page already says this). If traffic grows, enable billing in AI Studio and **set a budget alert** in Google Cloud Billing.

---

## Step 2 — Set up Brevo for support emails (10 min)
1. Sign up free at **https://www.brevo.com** and complete the short onboarding form.
2. **Verify your sender address:** top-right menu → **Senders, Domains & Dedicated IPs** → **Senders** → **Add a sender** → enter your Gmail (e.g. `you@gmail.com`) → enter the 6-digit code they email you.
3. **Create an API key:** top-right menu → **SMTP & API** → **API Keys** tab → **Generate a new API key** → name it `lookintothestuff` → **copy it** (starts with `xkeysib-…`).

💡 The first support emails may land in **Spam**. Mark them "Not spam" and create a Gmail filter for subjects containing `[LTS-`.

---

## Step 3 — Put the code on GitHub (5 min, no Git needed)
1. Create a free account at **https://github.com**.
2. Click **+** (top right) → **New repository** → name: `lookintothestuff` → choose **Private** → **Create repository**.
3. On the new page, click **"uploading an existing file"**.
4. Open your extracted folder, **select everything inside it** (including the `public` folder), and **drag it onto the GitHub page**.
   - ✅ Check that `public/`, `server.js`, `package.json`, `package-lock.json` and `render.yaml` all appear in the list.
   - ❌ Never upload a `.env` file or a `node_modules` folder.
5. Click **Commit changes**.

---

## Step 4 — Deploy on Render (10 min)
1. Go to **https://render.com** → **Get Started** → **Sign up with GitHub**.
2. Click **+ New** → **Web Service** → **Connect GitHub**. Grant access to the `lookintothestuff` repo → select it.
3. Fill in:

| Field | Value |
|---|---|
| Name | `lookintothestuff` (this becomes your URL) |
| Region | **Singapore** |
| Branch | `main` |
| Runtime / Language | **Node** |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | **Free** |

4. Scroll to **Environment Variables** → **Add** each of these:

| Key | Value |
|---|---|
| `GEMINI_API_KEY` | your `AIza…` key |
| `GEMINI_MODEL` | `gemini-3.8-flash` |
| `BREVO_API_KEY` | your `xkeysib-…` key |
| `SUPPORT_EMAIL` | the inbox that should receive tickets (e.g. `you@gmail.com`) |
| `SMTP_FROM` | the **verified Brevo sender** (same Gmail is fine) |
| `NODE_VERSION` | `20` |

5. Open **Advanced** → **Health Check Path** → `/api/health`.
6. Click **Deploy Web Service**. Wait 2–4 minutes until you see **"Live"**. The log should show:
   ```
   lookintothestuff running on :10000 (model gemini-3.8-flash) · email: brevo
   ```
   (Render picks the port itself; 10000 is normal.)

🎉 Your site is live at **https://lookintothestuff.onrender.com**. If that name was taken, Render shows your actual URL at the top of the page.

---

## Step 5 — Launch checklist (test everything)
- [ ] The badge in the top-right corner says **● AI online** (not "demo mode").
- [ ] Paste a short video (e.g. a 3–5 minute tutorial) → summary appears → clicking a timestamp jumps the player.
- [ ] Switch to **Detailed** → new summary; switch back to **Standard** → instant (from cache ⚡).
- [ ] Ask a question in **Ask this video** → answer with timestamps.
- [ ] Paste `https://google.com` → shows "not a valid YouTube link".
- [ ] **Chat** → Nova replies.
- [ ] **Support** → submit a test using a *different* email → you get the ticket in `SUPPORT_EMAIL`. Hit **Reply**: it should be addressed to the user. The user also gets a confirmation email.
- [ ] Open the site on your phone and check that the layout works.
- [ ] Privacy and Terms links work (footer).

---

## Updating the site later
Edit any file on GitHub (open it → ✏️ pencil icon → **Commit changes**) or upload replacements. **Render redeploys automatically** within about 2 minutes.

To change a key: Render → your service → **Environment** → edit → **Save, rebuild and deploy**.

---

## Free-plan limits (and how to handle them)
| Limit | What happens | Fix |
|---|---|---|
| Sleeps after 15 min idle | The first visit takes about 50 s to wake up (the badge shows "waking up…") | Upgrade to Render **Starter (~$7/mo)**, or use a free **UptimeRobot** monitor to ping `/api/health` every 10 min |
| Memory resets on sleep/redeploy | The summary cache is cleared | Fine for launch. Add Redis (Upstash, free) later |
| Gemini free-tier quotas | Users see "AI quota temporarily exhausted" | Enable billing and set a budget alert |
| Brevo 300 emails/day | Extra support emails fail with a friendly error | More than enough at launch. Paid plans are cheap |

---

## Troubleshooting
| Symptom | Cause → Fix |
|---|---|
| Badge says **demo mode** | `GEMINI_API_KEY` is missing → add it in Render → Environment |
| "AI service rejected the request. API key not valid" | Key was copied with spaces or is wrong → copy it again from AI Studio |
| "AI model … not found" | The model name changed → set `GEMINI_MODEL` to a current one from https://ai.google.dev/gemini-api/docs/models |
| "This video could not be analysed" | The video is private, age-restricted or too long → try another. On the free tier, keep videos under about 45 min |
| Support says "could not send your message" | Check Render **Logs** for `Brevo 4xx`: **401** = wrong API key; **400 sender** = `SMTP_FROM` isn't a verified sender |
| Build fails: "Cannot find module" | `package.json` or `server.js` wasn't uploaded to the **top level** of the repo (not inside a subfolder) |
| Page is blank or unstyled | The `public/` folder is missing in GitHub → upload it again |

---

## Security must-dos
1. Keys live **only** in Render's Environment tab. Never put them in GitHub or in front-end code.
2. In **Google Cloud Console → APIs & Services → Credentials**, edit your key → **API restrictions** → allow only **Generative Language API**.
3. If a key ever leaks, **delete it and create a new one** right away (AI Studio / Brevo), then update Render.
4. Turn on **2-factor authentication** for GitHub, Render, Google and Brevo.

---

## After launch (optional next steps)
1. **Custom domain** (~₹800/yr for `lookintothestuff.com` from Cloudflare/Namecheap): Render → Settings → **Custom Domains** → add it → create the CNAME record Render shows you. HTTPS is set up automatically.
2. **Google Search Console** → add your URL so the site appears in search results.
3. **Analytics:** add a privacy-friendly tracker (Plausible / Umami / PostHog).
4. **Share it:** Product Hunt, Reddit (r/InternetIsBeautiful, r/SideProject), X/LinkedIn, and student WhatsApp groups. Study-notes summaries are a great hook for students.
