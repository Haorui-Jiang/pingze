# Pingze Meter & Rhyme Query Station

[![Node](https://img.shields.io/badge/Node-20%2B-339933)](https://nodejs.org)
[![Engine](https://img.shields.io/badge/Engine-Local%20Dictionary-8b5a2b)](./结果/pingze-engine.js)
[![DeepSeek](https://img.shields.io/badge/LLM-DeepSeek--V4.1--Flash-4d6bfe)](https://www.deepseek.com)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ecf8e)](https://supabase.com)
[![Netlify](https://img.shields.io/badge/Deploy-Netlify-00c7b7)](https://www.netlify.com)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[中文](./README.md)　　[English](./README.en.md)

> Paste a classical Chinese poem and get **per-character tonal (pingze) annotation** plus the
> *Ping Shui Rhyme* (平水韵) category of each sentence's final character.
> Tonal analysis runs as a **local dictionary lookup in the browser** (106 rhyme categories, 7,000+ characters) —
> millisecond results, works offline, no LLM involved. AI (DeepSeek) powers only **optional**
> prosody analysis / poetic appreciation behind two independent toggles, quota-metered for signed-in users.
> Reference site: `http://www.zhgc.com/pz/pz.asp`

**Live demo**: <https://www.pingze.site/>

---

## ✨ Features

### 1. Pingze query (core, fully local)

- **Per-character tonal annotation**: Ping 平 / Ze 仄 / Tong 通 (polyphonic, both readings) / ？ (undetermined) /
  uncollected (full-width space placeholder) — aligned character-by-character with the input, never shifted.
- **Sentence-final rhyme categories**: each clause line ends with 「◆ final char【rhyme】」, ordered
  level-rising → level-falling → rising → departing → entering tone; if the final character has no category
  the engine steps back one character; polyphonic characters list all their categories.
- **Live statistics**: total characters, ping count, and ze count.
- **Historical tone derivation**: tones are derived from a reverse "character → rhyme category" index —
  level-tone rhymes only → ping; rising/departing/entering only → ze; both → tong.
- **Input rules**: 1,000-character cap; half/full-width spaces and tabs stripped; clause splitting follows a
  fixed punctuation table (runs merged, leading/trailing punctuation produces no empty clause); uncollected
  characters stay in place as placeholders.
- **One-click copy**: the full result (text + tone string + rhyme categories + statistics) in one action.
- **Zero server cost**: everything runs in the browser — no backend request, no quota, works offline.
  The query is **permanently free and requires no login**.

### 2. AI insight (optional, dual toggles)

- **Two independent switches**: "AI prosody analysis" and "poetic appreciation", **both off by default**;
  the generate button only appears when a switch is on, and no request is made while both are off
  (verifiable in the browser's network panel).
- **AI prosody analysis**: takes the deterministic local lookup result (tone string, rhyme categories) as
  input and evaluates adherence, lonely ping, triple-ping endings,救 remedies, antithesis, and rhyme grouping —
  the prompt explicitly requires the model to treat the passed-in table as authoritative.
- **Poetic appreciation**: imagery, structure, rhetoric, and allusions.
- **Server-side enforcement**: switch state and quota are re-validated on the server; quota is deducted
  atomically *before* calling the model, and a quota outage degrades to "allow" rather than blocking.
- **Failure isolation**: an AI failure only affects that one generation — the lookup result above stays intact.
- **Per-call quota**: 3/day for free users, 10/day for members, reset on the Beijing-time calendar day
  (`ai_usage_today()` / `ai_quota_consume()` RPCs; the latter is security definer for atomic deduction).

### 3. Accounts and data

- **Email + password sign-up / sign-in** backed by Supabase Auth, with automatic session refresh.
- **Query records**: signed-in users can save each query ("☆ Save this query") and replay or delete it from
  the records panel; the panel collapses and the button label follows its state; RLS guarantees you can only
  read / insert / delete your own records.
- **Save-and-see**: saving auto-opens and refreshes the panel (already-open panels only refresh, no scroll);
  three hints tell anonymous visitors that saving requires signing in.

### 4. Membership and operations

- **Daily quota**: 3/day for free users, 10/day for members (AI insight only — the lookup never counts).
- **Upgrade prompt**: when AI quota runs out, a QR-code modal invites the user to subscribe (¥30 for 30 days);
  quota is authoritative on the server via RPC, so refreshing the page cannot bypass it.
- **Admin console at `/admin`**: authenticated by an email allow-list (`ADMIN_EMAILS`), re-validated on the
  server with `service_role` (the frontend is a convenience layer only). Browse users, query-record counts,
  today's AI usage, sign-up and last sign-in times (all Beijing time), and change membership tier with an
  expiry countdown.
- **Membership validity**: a member is valid only when `tier = member` **and** `member_expires_at > now()`.
  Expiry does not auto-downgrade — the tier simply goes inactive, leaving the operator to renew or downgrade
  deliberately, which keeps reconciliation simple.
- **Sign-up rate limiting**: per-IP hourly cap plus a site-wide hourly cap; if counting fails, requests are
  allowed rather than blocking legitimate sign-ups.

### 5. Engineering

- **Zero dependencies, zero build step**: vanilla HTML / CSS / JS on the frontend; only Node built-ins on the
  backend. No `node_modules`, no bundler.
- **One implementation, two runtimes**: the shared modules under `lib/` are used by both the local server and
  the Netlify functions, so the two backends cannot drift apart.
- **Strict data isolation**: RLS policies plus column-level privileges; users cannot promote themselves to
  `member` or tamper with quota counters.
- **Beijing-time everywhere**: the database default timezone is `Asia/Shanghai`, so all timestamps render in
  UTC+8 while storage stays in absolute UTC.
- **SEO ready**: both public pages (`/` and `/pingshui-yun`) carry title / description / keywords / OG tags and
  Baidu Analytics; `tools/gen-sitemap.js` regenerates the sitemap.

---

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML / CSS / JS (zero deps; rice-paper background + Kai typeface + vermilion-red, classical style) |
| Lookup engine | `结果/pingze-engine.js` (UMD, require-able in Node, 42-assertion regression suite) |
| Local backend | Node.js 20+ native `http` + `fetch` (`server.local.js`) |
| Production backend | Netlify Serverless Functions (`netlify/functions/`) |
| Database / Auth | Supabase (Postgres + Auth + RLS) |
| LLM | DeepSeek-V4.1-Flash (API model ID `deepseek-flash`, AI insight only) |

> **On model IDs**: the DeepSeek API only accepts lowercase IDs (`deepseek-flash` / `deepseek-v4-pro`),
> not display names. The code maps display names via `MODEL_ALIAS`, so `DEEPSEEK_MODEL` accepts either form.

---

## 📁 Project Structure

```
pingze/
├── 结果/                      # Static site publish directory (netlify.toml: publish = "结果")
│   ├── index.html             # Home: lookup UI + auth modals + query-records panel + AI dual toggles + upgrade QR modal
│   │                          #   　<head> contains the Baidu site-verification meta (see "Site verification")
│   ├── pingshui-yun.html      # Ping Shui Rhyme 106-category reference table (SEO page)
│   ├── pingshui-yun-data.js   # Rhyme table data (window.PINGSHUI_YUN)
│   ├── pingze-engine.js       # Local lookup engine: tones / final-char rhymes / duplicates (V5 core, UMD)
│   ├── auth.js                # Frontend auth & data layer: sign-in, query records, quota
│   ├── admin.html  admin.js   # Admin console (email allow-list auth)
│   ├── supabase-config.example.js  # Frontend config template (copy to supabase-config.js and fill in)
│   ├── baidu_verify_codeva-W1T8O1gd3p.html  # Baidu site-ownership verification file — name and content must not change
│   └── 二维码.jpg             # Membership payment QR code
├── lib/                       # Server-side logic shared by the local backend and the Netlify functions
│   ├── supabase-store.js      # Supabase REST access layer, JWT → user
│   ├── auth.js                # Identity resolution, sign-up rate limiting
│   ├── admin.js               # Admin auth + user listing + membership tier changes
│   └── ai-insight.js          # AI insight: login check, atomic quota, DeepSeek call (new in V5)
├── netlify/functions/         # Production backend (behaviour-identical to the local one)
│   ├── ai-insight.js          # POST /api/ai-insight (type: analysis | appreciation)
│   ├── register.js            # POST /api/register
│   ├── admin-users.js         # GET  /api/admin-users
│   └── admin-set-tier.js      # POST /api/admin-set-tier
├── supabase/migrations/       # Database migrations (run in filename order)
├── scripts/
│   └── gen-supabase-config.js # Generates 结果/supabase-config.js at build time (see "Deploying to Netlify")
├── netlify.toml               # Publish dir, functions dir, build command, per-function timeouts, route rewrites
├── package.json
├── server.local.js            # Local dev backend (also serves static files, mirroring Netlify)
├── .env.example               # Server-side environment variable template
└── LICENSE
```

> Since V5 the old `netlify/functions/analyze.js` (AI per-character tone judging) has been removed —
> tone analysis is now pure frontend lookup, and the `/api/analyze` route is gone.

---

## 🚀 Running Locally

Prerequisite: **Node.js 20+** (uses built-in `fetch` and `process.loadEnvFile`).
The project has zero npm dependencies — there is nothing to install.

```bash
# 1. Server-side environment variables
cp .env.example .env      # at least DEEPSEEK_API_KEY (AI insight only; the lookup does not need it)

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
# {"ok":true,"model":"deepseek-flash","keyReady":true,"supabase":true,"note":"平仄/韵部查询为浏览器本地查表，不经过本服务；AI 赏析需登录并按次计配额"}
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
2. Open the **SQL Editor** (or the workspace helper `python db/sb.py sqlfile <script>`) and run the scripts
   under `supabase/migrations/` **one at a time, in filename order**:

| Script | Purpose |
|---|---|
| `0000_bootstrap_exec_sql.sql` | Creates the `service_role`-only `exec_sql` RPC used by later migrations and admin SQL. **Must run first.** |
| `0001_p0_strict.sql` | Initial core tables with strict RLS (profiles / poems / analyses / analysis_cache / api_usage / feedback; the latter five are dropped by `0007`) |
| `0002_fix_column_privileges.sql` | Column-level privileges (revoke at table level, then grant column by column) to block self-promotion |
| `0003_fix_quota_counting.sql` | Quota accounting: only `ok` / `timeout` count; cache hits and over-quota retries are free |
| `0004_set_daily_quota_10.sql` | Sets the default daily quota to 10 |
| `0005_simplify_profiles.sql` | Reduces `profiles` to `(id, email, created_at)` |
| `0006_membership.sql` | Membership: `tier` / `member_since` / `member_expires_at`, validity rules, and anti-promotion triggers |
| `0007_v5_query_engine.sql` | **V5 main migration**: drops the poems / analyses / analysis_cache / api_usage / feedback tables; creates the `queries` table (RLS: own rows read/insert/delete, anon fully revoked); adds `ai_used_date` / `ai_used_count` counter columns to profiles; creates the `ai_usage_today()` / `ai_quota_consume(uuid)` RPCs |
| `20261016000347_set_timezone_cst.sql` | Sets the database default timezone to `Asia/Shanghai` (timestamps render in UTC+8; storage unchanged) |

3. If new tables are not visible over REST afterwards, run `NOTIFY pgrst, 'reload schema';`
   once to refresh the PostgREST schema cache.

> **Order matters**: `0000` provides the `service_role` RPC; `0002` must follow `0001`;
> `0006` must follow `0004`; `0007` drops tables created by the earlier migrations.

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
| `DEEPSEEK_API_KEY` | DeepSeek API key (AI insight only; the lookup does not use it) | ✅ |
| `SUPABASE_URL` | Project root URL — **do not append `/rest/v1`** | ✅ |
| `SUPABASE_SERVICE_KEY` | service_role key, **server-side only** | ✅ |
| `SUPABASE_ANON_KEY` | anon public key, **injected into the frontend at build time** (not used by the functions) | ✅ |
| `ADMIN_EMAILS` | Comma-separated allow-list for the admin console. If unset, **nobody can get in** (fail-closed) | ✅ |
| `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL` | Defaults: `DeepSeek-V4.1-Flash` / `https://api.deepseek.com` | optional |
| `FUNCTION_TIMEOUT_MS` | Per-call AI timeout, default `9000` (fits Netlify's free-tier 10s cap; Pro allows up to `25000`) | optional |
| `REGISTER_MAX_PER_IP` / `REGISTER_MAX_PER_HOUR` | Sign-up rate limits | optional |
| `NODE_VERSION` | `20` recommended | recommended |

> `SUPABASE_ANON_KEY` must have the **builds** scope enabled, otherwise the build cannot read it.

**Routing**: `netlify.toml` rewrites `/api/*` to `/.netlify/functions/:splat` and `/admin` to `/admin.html`.

> **Function timeout**: the free Netlify tier caps functions at 10 seconds. Since V5, tone queries never touch
> the server (the browser answers in milliseconds), so a timeout can only affect a single AI generation —
> and a failure there never invalidates the lookup result already on screen.

### 🔎 Site verification (Baidu)

Two verification markers live in the repository; either one satisfies Baidu, but **both must use the same
code** — changing the code means changing both:

| Method | Location | Notes |
|---|---|---|
| Verification file | `结果/baidu_verify_codeva-W1T8O1gd3p.html` | 32 bytes, content `b5da3bce8d976003fb0cec7f8984b6bc`, **no trailing newline**; name and content are immutable |
| Meta tag | inside `结果/index.html`'s `<head>` | `<meta name="baidu-site-verification" content="codeva-W1T8O1gd3p" />` |

Self-check: section 【3/5】 of `node tools/check-domain.js` asserts the file returns 200 with matching content
on a first request, that the home page `<head>` contains the meta, and **negatively that no historical
verification codes remain in `<head>`**.

> **When rotating the verification file** (the most error-prone step):
> 1. put the new file into `结果/` and delete the old one from `结果/`;
> 2. update the `FILES` allow-list in `tools/sync-pingze.js` — **remove the old entry**, otherwise the script
>    aborts with exit 1 on the missing source;
> 3. run `node tools/sync-pingze.js`: it deletes the stale verification file in the repo as an **orphan**
>    (see its "2.5" section), so no manual `git rm` is needed;
> 4. update the meta tag in `结果/index.html` and the table above, then commit and push.

### ℹ️ A 304 on the verification file is normal, not a fault

When you inspect the file in the browser's network panel you will **often see `304 Not Modified` — this is
normal and needs no fix**.

Static files are served with `Cache-Control: public,max-age=0,must-revalidate` + `ETag` (Netlify default).
On a **repeat** visit the browser sends `If-None-Match: <ETag>`; Netlify confirms the content is unchanged and
replies **304 + empty body**, letting the browser use its cached copy. This does not affect verification:

| Request shape | Expected status | Meaning |
|---|---|---|
| Fresh visitor (no conditional headers) | **200** + full body | This is what a search engine's first fetch looks like |
| Crawler UA (Baiduspider, etc.) | **200** | Same as above |
| Stale/forged `If-None-Match` | **200** | Proves the server really compares content |
| Correct `If-None-Match` (repeat visit) | **304** | Unchanged, saves bandwidth; **not an error** |

**The key distinction**: 304 means "unchanged"; 301/302 means "moved" — **only the latter breaks site
verification**. So as long as the **first request (no conditional headers) returns 200 with no `Location`**,
the site is healthy.

Self-check (first response, no redirect following, no cache headers):

```bash
curl -sS -o /dev/null -w "%{http_code} redirect=[%{redirect_url}]\n" \
  "https://www.pingze.site/baidu_verify_codeva-W1T8O1gd3p.html"
# Expected: 200 redirect=[]
```

Section 【3/5】 of `node tools/check-domain.js` runs this matrix automatically (fresh visitor / forged ETag /
crawler UA must all be 200; a correct-ETag revisit getting 304 is expected) and states in its conclusion that
"304 is expected, not an error", so a normal cache negotiation is never mistaken for a fault.

> ⚠️ Keeping multiple historical verification files in the repo has no upside: an old code is just a dead file
> and one more scannable file at the site root. Keep only the currently active one.

### ⚠️ Pretty URLs must stay OFF

This site's **Site settings → Build & deploy → Post processing → Pretty URLs must remain disabled**
(`processing_settings.html.pretty_urls = false` via the API).

When enabled, Netlify 301s every `.html` to a **lower-cased, extension-less** path. That is fatal for the
verification file: `结果/baidu_verify_codeva-W1T8O1gd3p.html` would first 301 to
`/baidu_verify_codeva-w1t8o1gd3p`, and Baidu/Google verification requires the target URL to return 200 on the
first request.

Criterion and self-check (no redirect following — look at the first response):

```bash
curl -sS -o /dev/null -w "%{http_code} %{redirect_url}\n" \
  "https://www.pingze.site/baidu_verify_codeva-W1T8O1gd3p.html"
# Expected: 200 with an empty redirect_url
```

> The setting is **site-level** and cannot be expressed in `netlify.toml`; after changing it you **must
> redeploy** for it to take effect (the 301 rules are baked into the CDN at deploy time). It is invisible in
> this repository — confirm it only via the API or the console.

### ⚠️ Do not enable GitHub Pages

Netlify at <https://www.pingze.site> is the **only** deployment target. **GitHub Pages must stay disabled**
(Settings → Pages → Source set to `None`; `GET /repos/{owner}/{repo}/pages` must return 404).

Two reasons:

1. The repository root is *not* the site root — the site lives in `结果/`, set by `netlify.toml`'s `publish`.
   Enabling Pages would only publish the raw sources and serve `https://haorui-jiang.github.io/pingze/` as a
   **404 dead link**.
2. More practically: while Pages is enabled **every push creates a `github-pages` deployment record**
   (plus a matching environment), cluttering the repository's Deployments page.

One-time cleanup:

```bash
REPO=repos/Haorui-Jiang/pingze
gh api --method DELETE $REPO/pages                     # disable Pages (204)
gh api --method DELETE $REPO/environments/github-pages  # remove the leftover environment shell (204)
```

> Deleting a deployment record that is **active** returns **422**
> (`We cannot delete an active deployment unless it is the only deployment in a given environment.`);
> first `POST /repos/{owner}/{repo}/deployments/{id}/statuses` with `state=inactive`, then delete.

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
AI quota deduction is only possible through the security-definer `ai_quota_consume(uuid)` RPC — clients
cannot write the counter columns directly.

---

## ⚠️ Known Limitations

- **Sign-up does not verify that an email address is real.** To sidestep Supabase's strict default SMTP
  rate limits, sign-up goes through the server-side `/api/register`, which uses `service_role` to create an
  already-confirmed account. Anyone can therefore register with a fake address; abuse is contained by
  `REGISTER_MAX_PER_IP` / `REGISTER_MAX_PER_HOUR`. Once a custom SMTP provider is configured
  (requiring a domain with SPF/DKIM/DMARC), email confirmation should be restored and sign-up reverted to
  `client.auth.signUp`.
- **The lookup engine deliberately does not** detect genre, validate metre (adherence / lonely ping /
  triple-ping endings / 拗救), check horse-step rhyme, or disambiguate by context — consistent with the V4.2
  scope. Those analyses belong to the optional AI insight, as hints only.
- **Characters missing from the rhyme table** (later or variant characters) appear as「？」placeholders that
  keep positions intact; duplicate detection does not unify simplified/traditional forms (云 ≠ 雲).
- **This repository contains the application only**: operational scripts such as bulk data wipes and smoke
  tests were development by-products and are not included.

---

## 📜 License

MIT — free to use for learning and further development. See [LICENSE](./LICENSE).
