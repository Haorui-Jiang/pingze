# Pingze Meter & Rhyme Query Station · DeepSeek

[![Node](https://img.shields.io/badge/Node-20%2B-339933)](https://nodejs.org)
[![DeepSeek](https://img.shields.io/badge/LLM-DeepSeek--V4.1--Flash-4d6bfe)](https://www.deepseek.com)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ecf8e)](https://supabase.com)
[![Netlify](https://img.shields.io/badge/Deploy-Netlify-00c7b7)](https://www.netlify.com)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[中文](./README.md)　　[English](./README.en.md)

> Paste a classical Chinese poem and get per-character tonal (pingze) annotation, automatic genre detection,
> and rhyme-category tracing against the *Ping Shui Rhyme* (平水韵) system.
> Tonal analysis is **inferred in real time by the DeepSeek LLM** instead of a per-character lookup table,
> so it also handles polyphonic characters and irregular variants a static dictionary misses.
> Reference site: `http://www.zhgc.com/pz/pz.asp`

**Live demo**: <https://pingze.site/>

---

## ✨ Features

### 1. Prosody analysis (core)

- **Per-character tonal annotation**: Ping 平 (green) / Ze 仄 (red) / Tong 通 (ambiguous, gray) / ？ (undetermined) /
  — (punctuation and other non-Han characters) — aligned character-by-character with the input.
- **Automatic genre detection**: identifies forms such as Wuyan Lüshi (five-character regulated verse),
  Qiyan Jueju (seven-character quatrain), or Ci poetry, based on line count, characters per line, antithesis, and rhyme.
- **Ping Shui Rhyme tracing**: reports the rhyme category under the *Ping Shui Rhyme* system
  (e.g. 上平一东 "Shangping Yidong", 下平七阳 "Xiaping Qiyang"), listing multiple categories when applicable.
- **Prosody commentary**: each result carries a short note on the metre.
- **One-click copy**: the complete result can be copied to the clipboard in a single action.
- **Visible progress**: rotating status hints are shown while waiting, so the page never looks frozen.
- **Input sanitisation**: line breaks, half-width/full-width spaces, and tabs are stripped before submission.
- **Live character counter**: turns red past 40 characters and suggests splitting the input (avoids timeouts).
- **Failure-mode hardening**: an incomplete or non-JSON backend response degrades into an explicit error,
  instead of rendering a misleading "genre — / 0 characters" pseudo-success.

### 2. Accounts and data

- **Email + password sign-up / sign-in** backed by Supabase Auth, with automatic session refresh.
- **Login required to analyse**: the server rejects anonymous requests **before** consulting the cache
  (`401 needLogin`), so anonymous visitors cannot freeload on already-cached results.
- **My Analyses**: a per-user history feed; the panel refreshes itself as soon as a new analysis completes.
- **My Works**: save / edit / delete your own poems; clicking a poem's body loads it back into the input box
  for re-analysis.
- **☆ Save as work**: one click to persist an analysis result, with duplicate-write protection, a loading state,
  and a persistent success message.
- **Result cache**: keyed by a hash of `(input text + model + engine version)`.
  **Cache hits cost no quota and return instantly.**

### 3. Membership and operations

- **Daily quota**: 1 analysis/day for free users, 10/day for members (reset on the Beijing-time calendar day).
- **Upgrade prompt**: when the free quota runs out, a QR-code modal invites the user to subscribe
  (¥1 / day, billed monthly — ¥30 for 30 days).
  - Quota is authoritative on the server via `usage_today()`, so refreshing the page cannot bypass it.
- **Admin console at `/admin`**: authenticated by an email allow-list checked on the server
  (the frontend is a convenience layer only). Browse users, analysis counts, API call counts,
  sign-up time and last sign-in; inspect and change membership tier with an expiry countdown.
- **Membership validity**: a member is valid only when `tier = member` **and** `member_expires_at > now()`.
  Expiry does not auto-downgrade — the tier simply goes inactive, leaving the operator to renew or downgrade
  deliberately, which keeps reconciliation simple.
- **Sign-up rate limiting**: per-IP hourly cap plus a site-wide hourly cap.
  If counting fails, requests are allowed rather than blocking legitimate sign-ups.

### 4. Engineering

- **Zero dependencies, zero build step**: vanilla HTML / CSS / JS on the frontend; only Node built-ins on the backend.
  No `node_modules`, no bundler.
- **One implementation, two runtimes**: the shared modules under `lib/` are used by both the local server and the
  Netlify functions, so the two backends cannot drift apart.
- **Strict data isolation**: RLS policies plus column-level privileges plus guard triggers; the cache table is
  completely invisible to clients.
  - Users cannot promote themselves to `member` or raise their own quota — `revoke`d column privileges and a
    BEFORE UPDATE trigger block it in two independent layers.

---

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML / CSS / JS (zero deps; rice-paper background + Kai typeface + vermilion-red, classical style) |
| Local backend | Node.js 20+ native `http` + `fetch` (`server.local.js`) |
| Production backend | Netlify Serverless Functions (`netlify/functions/`) |
| Database / Auth | Supabase (Postgres + Auth + RLS) |
| LLM | DeepSeek-V4.1-Flash (API model ID `deepseek-flash`) |

> **On model IDs**: the DeepSeek API only accepts lowercase IDs (`deepseek-flash` / `deepseek-v4-pro`),
> not display names. The code maps display names via `MODEL_ALIAS`, so `DEEPSEEK_MODEL` accepts either form.

---

## 📁 Project Structure

```
pingze/
├── 结果/                      # Static site publish directory (netlify.toml: publish = "结果")
│   ├── index.html             # Home page: analyser + auth modals + history/works panels + upgrade QR modal
│   ├── admin.html             # Admin console page (/admin)
│   ├── auth.js                # Frontend auth & data layer: sign-in, history, works, quota, upgrade prompts
│   ├── admin.js               # Admin logic: admin sign-in check + user table rendering + tier changes
│   ├── supabase-config.example.js  # Frontend config template (copy to supabase-config.js and fill in)
│   └── 二维码.jpg             # Membership payment QR code
├── lib/                       # Server-side logic shared by the local backend and the Netlify functions
│   ├── supabase-store.js      # Cache / quota / usage log / identity verification
│   ├── auth.js                # Sign-up (bypassing SMTP limits) + rate limiting
│   └── admin.js               # Admin auth + user listing + membership tier changes
├── netlify/functions/         # Production backend (behaviour-identical to the local one)
│   ├── analyze.js             # POST /api/analyze
│   ├── register.js            # POST /api/register
│   ├── admin-users.js         # GET  /api/admin-users
│   └── admin-set-tier.js      # POST /api/admin-set-tier
├── supabase/migrations/       # Database migrations (run in numeric order)
├── scripts/
│   └── gen-supabase-config.js # Generates 结果/supabase-config.js at build time (see "Deploying to Netlify")
├── netlify.toml               # Publish dir, functions dir, build command, per-function timeouts, route rewrites
├── package.json
├── server.local.js            # Local dev backend (also serves static files, mirroring Netlify)
├── .env.example               # Server-side environment variable template
└── LICENSE
```

---

## 🚀 Running Locally

Prerequisite: **Node.js 20+** (uses built-in `fetch` and `process.loadEnvFile`).
The project has zero npm dependencies — there is nothing to install.

```bash
# 1. Server-side environment variables
cp .env.example .env      # fill in at least DEEPSEEK_API_KEY

# 2. Frontend config (the browser cannot read .env, so it needs its own copy)
cp 结果/supabase-config.example.js 结果/supabase-config.js
#    fill in your Supabase Project URL and anon public key
#    (on Netlify this file is generated by the build script; only local dev needs it manually)

# 3. Start
npm start                 # equivalent to: node server.local.js
npm run dev               # equivalent to: node --watch server.local.js (auto-restart on change)
```

Open <http://localhost:3000>; the admin console is at <http://localhost:3000/admin>.

**Health check** (provided by the local backend only — this route does not exist on Netlify):

```bash
curl http://localhost:3000/api/health
# {"ok":true,"model":"deepseek-flash","keyReady":true,"supabase":true,"engineVersion":"..."}
```

`keyReady` / `supabase` tell you at a glance whether `.env` took effect.
If the port is busy, run `PORT=3001 npm start`.

> Changes to the **backend** (`server.local.js` / `lib/`) require a restart.
> Changes to static files under `结果/` do **not** — just refresh the browser
> (responses are served with `Cache-Control: no-cache`).

---

## 🗄 Database Setup

1. Create a Supabase project and collect the **Project URL**, **anon public key** (for the frontend)
   and **service_role key** (server-side only).
2. Open the **SQL Editor** and paste the scripts in `supabase/migrations/` **one at a time, in numeric order**:

| Script | Purpose |
|---|---|
| `0000_bootstrap_exec_sql.sql` | Creates the `service_role`-only `exec_sql` RPC used by later migrations and admin SQL. **Must run first.** |
| `0001_p0_strict.sql` | The six P0 core tables with strict RLS isolation (profiles / poems / analyses / analysis_cache / api_usage / feedback) |
| `0002_fix_column_privileges.sql` | Fixes column-level privileges (revoke at table level, then grant column by column) to fully block self-promotion |
| `0003_fix_quota_counting.sql` | Corrects quota accounting: only `ok` / `timeout` count; cache hits and over-quota retries are free |
| `0004_set_daily_quota_10.sql` | Sets the default daily quota to 10 |
| `0005_simplify_profiles.sql` | Reduces `profiles` to `(id, email, created_at)` |
| `0006_membership.sql` | Membership: `tier` / `member_since` / `member_expires_at`, validity rules, and anti-promotion triggers |

3. If new tables are not visible over REST afterwards, run `NOTIFY pgrst, 'reload schema';`
   once to refresh the PostgREST schema cache.

> **Order matters**: `0000` provides the `service_role` RPC; `0002` must follow `0001`
> (tables must exist before privileges can be changed); `0006` rewrites `usage_today()` and must follow `0004`.

---

## ☁️ Deploying to Netlify

This repository is already in a **clean, deployable shape**. `netlify.toml` declares the publish and functions
directories:

```bash
netlify deploy --prod
```

### The one build step: generating the frontend Supabase config

`结果/supabase-config.js` holds the real Project URL and anon key, is **excluded via `.gitignore`** and is
never committed — so it must be generated on the build machine. Without it the file 404s and the frontend
falls back to "account features disabled". `netlify.toml` therefore declares:

```toml
command = "node scripts/gen-supabase-config.js"
```

At build time that script writes the file from `SUPABASE_URL` + `SUPABASE_ANON_KEY` and enforces three checks:

1. both variables must be present;
2. the key must be a valid JWT whose `role` is **`anon`** — supplying a `service_role` key **fails the build**,
   so full database privileges can never leak into a browser;
3. the project ref in the URL must match the key's `ref`.

Any failure exits non-zero, **failing the build rather than silently shipping an empty config**.
Changing an environment variable requires a new deploy to take effect.

Set the following variables under the site's **Site settings → Environment variables**:

| Variable | Description | Required |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API key | ✅ |
| `SUPABASE_URL` | Project root URL — **do not append `/rest/v1`** | ✅ |
| `SUPABASE_SERVICE_KEY` | service_role key, **server-side only** | ✅ |
| `SUPABASE_ANON_KEY` | anon public key, **injected into the frontend at build time** (not used by the functions) | ✅ |
| `ADMIN_EMAILS` | Comma-separated allow-list for the admin console. If unset, **nobody can get in** (fail-closed) | ✅ |
| `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL` | Defaults: `DeepSeek-V4.1-Flash` / `https://api.deepseek.com` | optional |
| `REQUIRE_LOGIN` | Defaults to requiring login whenever Supabase is configured; set `0` to allow anonymous use | optional |
| `QUOTA_FREE` / `QUOTA_MEMBER` | Daily quotas for free / member tiers; must match `usage_today()` | optional |
| `ANON_DAILY_QUOTA` | Anonymous quota, effective only when `REQUIRE_LOGIN=0` | optional |
| `REGISTER_MAX_PER_IP` / `REGISTER_MAX_PER_HOUR` | Sign-up rate limits | optional |
| `NODE_VERSION` | `20` recommended | recommended |

**Routing**: `netlify.toml` rewrites `/api/*` to `/.netlify/functions/:splat` and `/admin` to `/admin.html`.

> **Do not enable GitHub Pages.** Netlify at <https://pingze.site> is the only deployment target.
> The repository root is *not* the site root (the site lives in `结果/`, set by `netlify.toml`'s `publish`),
> so Pages would only publish the raw sources and serve `https://haorui-jiang.github.io/pingze/` as a
> **404 dead link**. Worse, while Pages is enabled **every push creates a `github-pages` deployment record**
> (plus a matching environment), cluttering the repository's Deployments page. Keep Pages disabled
> (`GET /repos/{owner}/{repo}/pages` must return 404); see the Chinese README for the cleanup commands.

> **Function timeout**: the free Netlify tier caps functions at 10 seconds, which long DeepSeek inferences
> easily exceed. Keep single submissions under ~40 characters. On a Pro plan you can raise
> `[functions.<name>] timeout` in `netlify.toml` to 26.
> Note that `functions.timeout` must be declared **per function as an object** — a scalar value makes Netlify
> reject the deployment.

---

## 🔐 Secrets and Security

**Never committed** (already excluded by `.gitignore`):

- `.env` / `.env.local` — contain `DEEPSEEK_API_KEY` and `SUPABASE_SERVICE_KEY`
- `结果/supabase-config.js` — contains the real Supabase URL and anon key
  (the repository ships only the `.example.js` template; on Netlify it is generated at build time by
  `scripts/gen-supabase-config.js` — see "Deploying to Netlify")

**`anon` key vs `service_role` key** — the most common source of mistakes here:

| Key | Location | Safety |
|---|---|---|
| `anon` public key | Frontend `结果/supabase-config.js`; visible to any browser | Public by design. RLS policies are what actually protect the data. |
| `service_role` key | Server-side environment variables only | **Bypasses all permissions.** Shipping it to the frontend hands the whole database to anyone. |

**Database-side hardening**: RLS governs rows, not columns. On top of RLS the project applies
① `revoke update on <table>` to drop the table-level grant, then `grant update (<safe columns>)` column by column;
and ② BEFORE UPDATE guard triggers that restore protected columns. Both live in the migration scripts.

---

## ⚠️ Known Limitations

- **Sign-up does not verify that an email address is real.** To sidestep Supabase's strict default SMTP
  rate limits, sign-up goes through the server-side `/api/register`, which uses `service_role` to create an
  already-confirmed account. Anyone can therefore register with a fake address; abuse is contained by
  `REGISTER_MAX_PER_IP` / `REGISTER_MAX_PER_HOUR`. Once a custom SMTP provider is configured
  (requiring a domain with SPF/DKIM/DMARC), email confirmation should be restored and sign-up reverted to
  `client.auth.signUp`.
- **10-second function timeout on the free tier**: long texts are cut off by the platform;
  the frontend surfaces an actionable message suggesting smaller batches.
- **This repository contains the application only**: operational scripts such as bulk data wipes and smoke
  tests were development by-products and are not included.

---

## 📜 License

MIT — free to use for learning and further development. See [LICENSE](./LICENSE).
