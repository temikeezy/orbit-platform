# Deploy your own ORBIT

ORBIT is a platform for running internship, industrial-training (SIWES), NYSC and volunteer programmes. Applicants apply, get admitted and placed in streams, take weekly tasks, submit work, get marked, earn points and badges, keep a logbook, and talk to each other. It was built by Ilorin Innovation Hub for its own programmes and is released under the **AGPL-3.0**.

This guide takes a new organisation from `git clone` to a running deployment. Allow about an hour.

## What you need

| | Why |
|---|---|
| **Node.js 20+** and npm | Build and CLI |
| A **[Convex](https://convex.dev) account** (free tier works to start) | The entire backend: database, functions, file storage, scheduled jobs, HTTP routes |
| An **SMTP provider** (ZeptoMail by default; any SMTP works via `SMTP_HOST`/`SMTP_PORT`) | Sign-in links, acceptance emails, notifications. ORBIT is mostly passwordless — without mail, new members cannot sign in |
| A **static host** (Netlify is configured; anything that serves `dist/` works) | The React front end |
| *Optional:* Zoho accounts for staff single sign-on | `ZOHO_*` variables |
| *Optional:* the Claude and Codex CLIs on an always-on machine | The automated marker, screener and helpdesk (see [Automation](#optional-the-automated-agent)) |

## 1. Get the code and a development deployment

```bash
git clone https://github.com/temikeezy/orbit-platform.git orbit && cd orbit
npm install
npx convex dev          # log in, create a project; writes VITE_CONVEX_URL to .env.local
```

Leave `npx convex dev` running in one terminal — it pushes `convex/` to your development deployment as you edit. Copy `.env.example` to `.env.local` if you need any of the other front-end variables it lists.

## 2. Configure the deployment

Server-side configuration lives on the Convex deployment, not in a file. Set it with `npx convex env set NAME value` (add `--prod` for production). `.env.example` lists every variable with a one-line purpose; the ones that matter first:

| Variable | Required | Purpose |
|---|---|---|
| `APP_URL` | yes | Your front end's public URL. Every emailed link and the CORS allowlist use it |
| `SMTP_USER`, `SMTP_PASSWORD` | yes | Mail credentials |
| `EMAIL_FROM` | yes | Sender address — must be verified with your mail provider |
| `EMAIL_FROM_NAME` | | Sender display name |
| `SMTP_HOST`, `SMTP_PORT` | | Default `smtp.zeptomail.com` |
| `ORBIT_ORG_NAME`, `ORBIT_ORG_SHORT_NAME`, `ORBIT_ORG_ADDRESS` | recommended | Your organisation's name and postal address, used in emails and letters |
| `ORBIT_AGENT_EMAIL` | recommended | The automated agent's account email (e.g. `orbit.agent@your-domain`) |
| `ALLOWED_OAUTH_DOMAINS`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI` | | Staff SSO via Zoho, limited to your domain |
| `EMAIL_SINK`, `EMAIL_ALLOWLIST`, `EMAIL_PAUSED` | | Safety switches for non-production deployments: discard, restrict, or hold outgoing mail |

For the front end, set `VITE_ORG_NAME`, `VITE_ORG_SHORT_NAME`, `VITE_ORG_URL` and `VITE_OAUTH_DOMAIN_HINT` in `.env.local` (and on your host). They are baked in at **build** time.

## 3. Bootstrap: the first admin and the starting data

On a new deployment nobody can sign in yet. One command creates the first super admin, the ORBIT Agent account, the settings rows, a level ladder, a starter set of badges, the tracks and — if you give dates — the first cohort:

```bash
npx convex run setup:bootstrap '{
  "adminEmail": "you@your-org.org",
  "adminName": "Your Name",
  "cohort": { "name": "Cohort 1", "startDate": "2026-10-05", "endDate": "2026-12-18" }
}'
```

It prints a one-time **sign-in link**. Open it, then set a password under **Settings**. Add `"dryRun": true` to see what it would create first.

It refuses until `APP_URL` is set, because the link is built from it. For local development that is `npx convex env set APP_URL http://localhost:5173`.

The command refuses to run once any admin exists, so it cannot be used to create a second owner on a live deployment. It runs only with deployment credentials — nobody can reach it from the browser.

Then, in the app:

1. **Streams** — Admin → Streams. Create the teams interns join, and **attach each to a track**: automatic placement only chooses streams that belong to a track.
2. **Cohort** — Admin → SIWES → Cohorts, if you did not pass one above. Tasks cannot be created without an active cohort.
3. **Levels and badges** — Admin → Gamification. The seeded ones are a starting point.
4. **Staff** — Admin → Users. Only a super admin can create accounts and grant admin.

## 4. Make it yours

These are deliberate customisation points in the code:

| What | Where |
|---|---|
| Tracks applicants choose from | `convex/lib/tracks.ts` (`TRACK_SEED`) — the application form validates against this list |
| The weekly task bank (fallback when the agent is not running) | `convex/lib/taskSeed.ts` — written for IIH's streams; replace with your own |
| Brand colours | `tailwind.config.js` (the `iih` palette) |
| Acceptance-letter letterhead and logo | `src/assets/letterhead/`, `convex/lib/letterhead.ts` |
| Acceptance-letter signature | `convex/lib/signature.ts` — ships with a fictional "Jane Doe (sample)"; replace it with your signatory's image |
| Programme types (`siwes`, `internship`, `nysc`, `volunteer`) | `convex/lib/programme.ts` |
| Prompts for the automated agent | `scripts/agent/*.py` |

**Set your name in both places.** The organisation name on the printed letter and in the app comes from `VITE_ORG_NAME` (front end, build time); the emailed PDF letter and all email copy use `ORBIT_ORG_NAME` (Convex environment). Set both to the same value, or the two letters will disagree.

**Known limitation:** times are West Africa Time (UTC+1, no daylight saving) throughout — deadlines, reminders and cron schedules. Supporting another timezone means changing `convex/lib/datetime.ts`, `convex/lib/cadence.ts` and the offsets in the `agent*.ts` modules; it is on the roadmap.

## 5. Deploy to production

```bash
npx convex deploy                     # creates/updates your production deployment
npx convex env set APP_URL https://orbit.your-org.org --prod   # …and every variable from step 2, with --prod
npx convex run setup:bootstrap '{"adminEmail":"…","adminName":"…"}' --prod
```

Build the front end with `VITE_CONVEX_URL` set to the **production** deployment URL (`npm run build`, publish `dist/`).

**On Netlify**, edit `netlify.toml` first: the `/api/calendar-ics` redirects name a Convex deployment — replace them with your production and development deployments' `.convex.site` URLs (and the same line in `public/_redirects`). Content-Security-Policy headers are in `netlify.toml` too; add your own image hosts if you use any.

## Optional: the automated agent

ORBIT can run with no staff at all. A small runner (`scripts/agent/`) marks submissions, screens applications, reviews logbooks, writes each week's tasks and answers interns' messages, using the Claude and Codex command-line tools. Every rule and fallback lives in Convex's scheduled jobs, so **ORBIT works without the runner** — work is then settled by timers instead of being individually judged, and staff can do everything from the admin screens. Setup: [`scripts/agent/README.md`](scripts/agent/README.md). How it works and why it is safe: [`docs/AUTOMATION_LOG.md`](docs/AUTOMATION_LOG.md).

## Tests

```bash
npm run typecheck && npm test && npm run lint && npm run build
python3 -m unittest discover -s scripts/agent -p 'test_*.py'
```

The Playwright suite (`npm run test:e2e`) runs against a **development** deployment only: set `ORBIT_DEV_DEPLOYMENT` to your dev deployment's name, `E2E_CONVEX_URL` to its URL, and `ORBIT_TEST_MCP_SECRET` to an MCP credential on it (see `MCP_CONNECTION_GUIDE.md`).

## Getting help

Open an issue on GitHub. Security problems: see [`SECURITY.md`](SECURITY.md#reporting-a-vulnerability) — please do not file them publicly.
