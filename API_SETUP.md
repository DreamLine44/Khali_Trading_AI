# API & endpoint setup — step by step

This walks through **every** external API key, endpoint, and secret referenced
in `.env.example`, grouped by what they're for, in the order you'd realistically
set them up. Nothing here is fetched or guessed — each step was checked against
that provider's actual current signup flow / API docs while writing this file.

Ground truth for what each variable does and its default is always
`src/config/env.ts`. This file only covers **where the value comes from**.

> Quick nav: [MT5 bridge](#1-mt5-bridge-required-for-paperlive) ·
> [MongoDB](#2-mongodb-required-for-paperlive) ·
> [Market data — Twelve Data](#3-market-data-twelve-data-optional-recommended) ·
> [Market data — Binance](#4-market-data-binance-optional-crypto-only) ·
> [Market data — generic vendor](#5-generic-vendor-market-data-slot-optional-advanced) ·
> [News/sentiment — Alpha Vantage](#6-newssentiment-alpha-vantage-required-for-live-pick-one) ·
> [Economic calendar — Finnhub](#7-economic-calendar-finnhub-required-for-live-pick-one-or-both) ·
> [Economic calendar — Trading Economics](#8-economic-calendar-trading-economics-optional-paid) ·
> [Generic evidence adapters](#9-generic-normalized-evidence-adapters-optional-advanced) ·
> [Live-activation secrets](#10-live-activation-secrets-self-generated) ·
> [Verifying it all loads](#verifying-it-all-loads)

---

## Before you start: do you need any of this?

- **Just running tests, the backtester, or the vertical slice?** Nothing here
  is required — an empty `.env` works.
- **Paper or live trading against a real MT5 terminal?** You need section 1
  (MT5 bridge) and section 2 (MongoDB) at minimum.
- **Going live?** Everything above, plus section 10 (live activation), plus
  **one** provider from section 6 (news/sentiment) and **one or more** from
  section 7/8 (economic calendar) — `LIVE_REQUIRE_EVIDENCE=true` cannot be
  turned off in live mode. The cheapest path is Alpha Vantage + Finnhub —
  both free, both satisfy the requirement, zero cost.
- Sections 3–5 (supplementary market data) are optional in every mode — MT5
  stays authoritative for execution regardless.

---

## 1. MT5 bridge (required for paper/live)

These aren't issued by any API — they come from your MT5 terminal and broker.

| Variable | Where it comes from |
|---|---|
| `MT5_ACCOUNT_ID` | Your MT5 login number, shown in the terminal's **Navigator → Accounts** panel or your broker's account-opening email. |
| `MT5_SERVER` | The server name shown next to your account number in the terminal (e.g. `ICMarketsSC-Demo`). |
| `MT5_COMMON_DIRECTORY` | In the terminal: **File → Open Data Folder**, then go up one level to `Common\Files` — the folder shared across *all* terminals on the machine, not the per-terminal one. Use forward slashes to avoid escaping issues: `C:/Users/<user>/AppData/Roaming/MetaQuotes/Terminal/Common/Files`. |
| `MT5_BRIDGE_SECRET` | You generate this yourself — e.g. `openssl rand -hex 32` — then paste the *identical* value into the EA's `InpBridgeSecret` input when attaching `mt5/Experts/AITradingBot/AITradingBot.mq5` to a chart. The Node side and the EA must match exactly, or every request fails authentication. |
| `MT5_SYMBOL`, `MT5_TIMEFRAME`, `MT5_MAGIC_NUMBER` | Your own choice. `MT5_MAGIC_NUMBER` should be unique per bot/account if you ever run more than one instance — reconciliation uses it to tell positions apart. |
| `MT5_BRIDGE_TIMEOUT_MS`, `MT5_MAX_REQUEST_AGE_MS`, `MT5_POLL_INTERVAL_MS`, `RECONCILIATION_FAILED_LOOKBACK_MS` | Tuning knobs with working defaults. Leave alone unless you understand the trade-off (see the inline comments in `.env.production.local`). |

**Steps:**
1. Open your MT5 terminal, note the account ID and server name (top-left panel).
2. **File → Open Data Folder → Common → Files**, copy that full path into `MT5_COMMON_DIRECTORY`.
3. Generate a secret: `openssl rand -hex 32` (or any equivalent ≥16-char random string generator).
4. Compile `AITradingBot.mq5` in MetaEditor, attach it to a chart, paste the same secret into its `InpBridgeSecret` input.
5. Fill in `MT5_ACCOUNT_ID` / `MT5_SERVER` / `MT5_BRIDGE_SECRET` / `MT5_COMMON_DIRECTORY` in your `.env`.

---

## 2. MongoDB (required for paper/live)

| Variable | Where it comes from |
|---|---|
| `MONGODB_URI` | Local dev: install MongoDB Community Edition, use `mongodb://localhost:27017`. Production: a real, backed-up, monitored instance — [MongoDB Atlas](https://www.mongodb.com/atlas) has a free tier; its **Connect** dialog gives you a `mongodb+srv://user:password@...` string. Don't use localhost in production. |
| `MONGODB_DATABASE` | Your own choice of database name. |

---

## 3. Market data — Twelve Data (optional, recommended)

Supplementary research/history data. MT5 stays authoritative for execution and pricing either way.

**Steps:**
1. Go to [twelvedata.com](https://twelvedata.com) → **Get free API key**.
2. Sign up with email — no card required for the free "Basic" tier.
3. Your key appears immediately on the dashboard under **API Keys**.
4. Paste it into `TWELVE_DATA_API_KEY=`.

Free tier is rate-limited (check the current daily-request cap on your
dashboard, historically ~800/day) — fine for the default `AUTO_RESEARCH_*`
polling intervals in `.env.production.local`. Tighten
`AUTO_RESEARCH_QUOTE_INTERVAL_MS` / `AUTO_RESEARCH_HISTORY_INTERVAL_MS` if
you add more symbols.

---

## 4. Market data — Binance (optional, crypto only)

Only relevant if you trade crypto symbols; irrelevant for a pure-forex bot.

**Steps:**
1. Log into Binance → **Profile → API Management**.
2. **Create API**, name it (e.g. `ai-trading-bot-readonly`).
3. Enable **only** "Enable Reading" — leave withdrawal/trading permissions off. This key is for market data only; `binance-market-data.provider.ts` never places orders.
4. Paste the key into `BINANCE_API_KEY=`.

Note: Binance's public market-data endpoints (`data-api.binance.vision`) don't
actually require a key at all — the provider works with this blank — a key
just raises your rate limit.

---

## 5. Generic vendor market-data slot (optional, advanced)

`VENDOR_DATA_PROVIDER` / `VENDOR_DATA_API_KEY` / `VENDOR_DATA_ENDPOINT` is a
legacy fallback adapter, not a specific named vendor. Leave it unset unless
you're wiring in a market-data source not covered above. If you do,
`VENDOR_DATA_ENDPOINT` must be a URL you control that returns the normalized
`{candles, quote}` JSON shape `vendor-market-data.provider.ts` expects — see
`README_FILES/docs/market-data.md`.

---

## 6. News/sentiment — Alpha Vantage (required for live — pick one)

**Steps:**
1. Go to [alphavantage.co/support/#api-key](https://www.alphavantage.co/support/#api-key).
2. Fill in your email/organization — no approval wait, no card.
3. Your key is shown on the same page immediately after submitting.
4. Paste it into `ALPHA_VANTAGE_API_KEY=`.

Free tier is a limited number of requests/day (check your account for the
current figure). `NEWS_REFRESH_INTERVAL_MS` (default 60s) is cached
per-symbol by `CachedEvidenceProvider`, so this comfortably covers a
single-symbol bot — lower your polling further if you add more symbols.

**Alternative — generic adapter:** `NEWS_EVIDENCE_ENDPOINT` + `NEWS_API_KEY`.
Use this only if you have a different authorized news/sentiment API and have
built (or will build) a small adapter service in front of it that returns
`{ observations: EvidenceObservation[] }` — see `authorized-http-provider.ts`.
There's no public signup for this variable itself; it's a URL you control.

---

## 7. Economic calendar — Finnhub (required for live — pick one or both)

**Steps:**
1. Go to [finnhub.io](https://finnhub.io) → **Get free API key**.
2. Sign up with email — no card.
3. Your key is on the dashboard under **API Keys** immediately after signup.
4. Paste it into `FINNHUB_API_KEY=`.

> **Verify at signup, don't assume:** Finnhub's free-tier endpoint coverage
> has changed over time for other endpoints on their platform, and pricing
> pages can lag behind what's actually enforced. Confirm `/calendar/economic`
> is still included on the free plan when you sign up — if it's been moved
> behind a paid tier since this was written, use Trading Economics (below)
> or a generic adapter instead. This is the one item in this whole guide we
> could not get a fully certain, current-day answer on.

This key alone satisfies the live-mode economic-calendar requirement — you
do not also need Trading Economics.

---

## 8. Economic calendar — Trading Economics (optional, paid)

**Steps:**
1. [tradingeconomics.com/api](https://tradingeconomics.com/api) → **Get a Key** / **Contact Sales**.
2. Their free `guest:guest` demo credentials return **sample data only** — not usable for live trading. A real key requires a paid plan; check current pricing before signing up.
3. If you have a paid key, paste it into `ECONOMIC_CALENDAR_API_KEY=`.

It runs *alongside* Finnhub if both are set — `evidence-aggregator.ts` merges
every fresh source rather than requiring exactly one.

**Alternative — generic adapter:** `ECONOMIC_EVIDENCE_ENDPOINT`, same pattern
as the news generic adapter — a URL you control returning the same
normalized `{ observations: [...] }` shape.

---

## 9. Generic normalized-evidence adapters (optional, advanced)

Two more slots, wired in `run-mt5.ts` but never mandatory — leave both blank
to skip entirely:

| Variable | Where it comes from |
|---|---|
| `DELTA_EVIDENCE_ENDPOINT` + `DELTA_API_KEY` | Base URL and key for whatever additional authorized evidence source you plug in under the name "delta" — not a specific named vendor this project integrates with by default. |
| `BINANCE_EVIDENCE_ENDPOINT` (+ `BINANCE_API_KEY`, shared with section 4) | Base URL for a Binance-derived evidence feed, if you have one beyond plain market data. |

---

## 10. Live-activation secrets (self-generated)

The one category that's deliberately hard to fill in by accident.

| Variable | Where it comes from |
|---|---|
| `LIVE_TRADING_ENABLED` | You set this to `true` yourself, deliberately. |
| `LIVE_ACTIVATION_TOKEN` | Self-generated, ≥32 characters — e.g. `openssl rand -hex 32`. Never reuse `MT5_BRIDGE_SECRET` or any other secret here; generate a fresh one. |
| `LIVE_ACTIVATION_CONFIRMATION` | Must be the exact literal string `I_UNDERSTAND_LIVE_TRADING`, typed by you as a second, separate confirmation. |
| `LIVE_REQUIRE_EVIDENCE` | Must stay `true` in live mode — `env.ts` throws if set to `false` while `TRADING_MODE=live`. |
| `LIVE_KILL_SWITCH_FILE` | A filesystem path of your own choosing that you can reach quickly in an emergency. Creating that file (any content) halts new entries immediately without touching existing protective stops. |

---

## Not obtained from anywhere

These are your own tuning/policy decisions, not values anyone issues:
- **Python / model registry:** `PYTHON_COMMAND` (leave blank almost always), `MODEL_STAGE`.
- **ML switch & safety thresholds:** `AI_ENABLED`, `AI_MODE`, `AI_MIN_PROBABILITY`, `AI_MAX_UNCERTAINTY`, `DECISION_MIN_CONFIDENCE`, `DRIFT_Z_THRESHOLD`, etc.
- **Risk controls:** `RISK_MAX_PER_TRADE_PCT`, `RISK_MAX_OPEN_POSITIONS`, `RISK_MAX_DAILY_LOSS_PCT`, `RISK_MAX_DRAWDOWN_PCT` — review these against your own account size before going live; the shipped defaults are a starting point, not a recommendation for you specifically.
- **Autonomous research/monitoring knobs:** poll intervals, alert thresholds, dashboard port — working defaults are already filled in.

---

## Verifying it all loads

```
NODE_ENV=development npx ts-node -e "import { env } from './src/config/env'; console.log('OK')"
NODE_ENV=production  npx ts-node -e "import { env } from './src/config/env'; console.log('OK')"
```

A missing *required* value throws immediately with the exact variable name —
that's `env.ts` telling you what's still missing, not a bug to work around.

For the full reference (every variable, including ones not covered above),
see [`README_FILES/ENVIRONMENT_VARIABLES.md`](README_FILES/ENVIRONMENT_VARIABLES.md).
For what broke and got fixed across every audit pass of this project,
including the data-channel audit that produced this file, see
[`README_FILES/CHANGELOG.md`](README_FILES/CHANGELOG.md).
