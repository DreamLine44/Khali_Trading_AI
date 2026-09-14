# Environment variables — where each value comes from

Ground truth for every variable is `src/config/env.ts` (the only place
`process.env` is read — the Python side under `ai/` takes no env vars at
all; its config flows through CLI args and JSON metadata). This document
explains, for each variable, **how you actually obtain or decide the
value**, not just what it defaults to.

Two ready-to-fill files already exist at the repo root for the two
realistic starting points:

- **`.env.development.local`** — loads automatically when `NODE_ENV=development`
  (the default). Nothing in it is required for `npm run run:slice` — an
  empty file works. It also has MT5/MongoDB placeholders, commented as
  optional, for the common next step of running paper mode locally.
- **`.env.production.local`** — loads automatically when `NODE_ENV=production`.
  Every secret in it is intentionally left blank; the app refuses to start
  in live mode until you fill them in yourself (see below) — that's
  `env.ts` failing closed on purpose, not a file left half-finished.

Both are already in `.gitignore` (`.env.*`) — never commit either one with
real values filled in.

## How to tell which variables you actually need

- **Just running the vertical slice / backtest / tests?** None. Skip
  straight to the next section if you're setting up live trading later.
- **Running paper, synthetic, or live mode against a real MT5 terminal?** You need
  the whole **MT5 bridge** section below, plus **MongoDB**.
- **Going live?** You need everything above, plus **Live activation**,
  plus at least one provider from **News/sentiment** and one from
  **Economic calendar** (required by `LIVE_REQUIRE_EVIDENCE=true`, which
  can't be turned off in live mode). `ALPHA_VANTAGE_API_KEY` +
  `FINNHUB_API_KEY` covers both categories for free.
- Every other section (**ML switch**, **risk controls**, **autonomous
  research/monitoring**) is a tuning knob with a working default — you
  decide these values yourself; nobody issues them to you.

---

## MT5 bridge

These come from the MT5 terminal and your broker, not from any API
signup.

| Variable | How to get it |
|---|---|
| `MT5_ACCOUNT_ID` | Your MT5 login number — shown in the terminal's top-left "Navigator → Accounts" panel, or in the account-opening email from your broker. |
| `MT5_SERVER` | The server name shown right next to your account number in the terminal (e.g. `ICMarketsSC-Demo`) — also in the same broker email. |
| `MT5_COMMON_DIRECTORY` | In the terminal: **File → Open Data Folder**, then go up one level to `Common\Files` (the folder shared across *all* terminals on the machine, not the per-terminal one). Forward slashes avoid escaping headaches: `C:/Users/<user>/AppData/Roaming/MetaQuotes/Terminal/Common/Files`. |
| `MT5_BRIDGE_SECRET` | Not issued anywhere — you generate this yourself, e.g. `openssl rand -hex 32`, then set the *identical* value in the EA's `InpBridgeSecret` input when attaching `AITradingBot.mq5` to a chart. The Node side and the EA must match exactly. |
| `MT5_SYMBOL` / `MT5_TIMEFRAME` / `MT5_MAGIC_NUMBER` | Your own choice, not fetched from anywhere. `MT5_MAGIC_NUMBER` should be unique per bot/account if you ever run more than one — reconciliation uses it to tell positions apart. |
| `MT5_BRIDGE_TIMEOUT_MS`, `MT5_MAX_REQUEST_AGE_MS`, `MT5_POLL_INTERVAL_MS`, `RECONCILIATION_FAILED_LOOKBACK_MS` | Tuning knobs with working defaults — change only if you understand the trade-off (see the inline comments in `.env.production.local`). |

## MongoDB

| Variable | How to get it |
|---|---|
| `MONGODB_URI` | For local development: install MongoDB Community Edition and use `mongodb://localhost:27017`. For production: use a real, backed-up, monitored instance — e.g. a [MongoDB Atlas](https://www.mongodb.com/atlas) cluster (free tier is fine to start) gives you a full `mongodb+srv://user:password@...` connection string from its "Connect" dialog. Don't use localhost or the dev-only JSONL fallback in production. |
| `MONGODB_DATABASE` | Your own choice of database name — not fetched from anywhere. |

## Research / historical market-data provider

Only needed if you want supplementary data beyond MT5 itself (MT5 remains
authoritative for execution either way — see `AUTO_RESEARCH_*` in the
autonomous-research section below for how this gets cross-checked).

**Twelve Data — `TWELVE_DATA_API_KEY`** (free tier, recommended default)
1. Go to [twelvedata.com](https://twelvedata.com) → **Get free API key**.
2. Sign up with email (no card required for the free "Basic" tier).
3. Your key is shown immediately on the dashboard at **API Keys**.
4. Paste it into `TWELVE_DATA_API_KEY=`. Free tier is rate-limited (800
   requests/day at time of writing) — fine for the default polling
   intervals in `.env.production.local`, tighten `AUTO_RESEARCH_*_INTERVAL_MS`
   if you increase symbols/timeframes.

**Binance — `BINANCE_API_KEY`** (only relevant for crypto symbols; optional for a pure-forex bot)
1. Log into your Binance account → **Profile → API Management**.
2. **Create API**, name it (e.g. `ai-trading-bot-readonly`).
3. When choosing permissions, enable only **Enable Reading** — leave
   withdrawal/trading permissions off. This key is for market data only.
4. Copy the key into `BINANCE_API_KEY=`. Public market-data endpoints
   (`data-api.binance.vision`) don't actually require a key at all —
   `binance-market-data.provider.ts` works with this blank too — but a
   key raises your rate limit.

**Generic vendor slot — `VENDOR_DATA_PROVIDER` / `VENDOR_DATA_API_KEY` / `VENDOR_DATA_ENDPOINT`**
Legacy fallback adapter — leave unset unless you're wiring in a
market-data vendor not covered by Twelve Data/Binance above. If you do,
`VENDOR_DATA_ENDPOINT` must return the normalized `{candles, quote}` JSON
shape `vendor-market-data.provider.ts` expects (see
`README_FILES/docs/market-data.md`).

## News/sentiment evidence (pick one — required for live)

**Alpha Vantage — `ALPHA_VANTAGE_API_KEY`** (free, recommended)
1. Go to [alphavantage.co/support/#api-key](https://www.alphavantage.co/support/#api-key).
2. Fill in your email/organization (no approval wait, no card).
3. Your key is shown on the same page immediately after submitting.
4. Paste it into `ALPHA_VANTAGE_API_KEY=`. Free tier is ~25 requests/day —
   `NEWS_REFRESH_INTERVAL_MS` (default 60s) is cached per-symbol by
   `CachedEvidenceProvider`, so this comfortably covers a single-symbol bot;
   lower your polling further if you add more symbols.

**Generic adapter — `NEWS_EVIDENCE_ENDPOINT` + `NEWS_API_KEY`**
Use instead of Alpha Vantage only if you have a different authorized
news/sentiment API and have built (or will build) a small adapter service
in front of it returning `{ observations: EvidenceObservation[] }` — see
`authorized-http-provider.ts`. There's no public signup for this variable
itself; it's a URL you control.

## Economic calendar evidence (pick one or more — required for live)

**Finnhub — `FINNHUB_API_KEY`** (free, recommended — real data, not a sandbox)
1. Go to [finnhub.io](https://finnhub.io) → **Get free API key**.
2. Sign up with email (no card).
3. Your key is on the dashboard at **API Keys** immediately after signup.
4. Paste it into `FINNHUB_API_KEY=`. Free tier is 60 calls/minute, which
   easily covers `ECONOMIC_REFRESH_INTERVAL_MS` (default 5 min). This key
   alone satisfies the live-mode economic-calendar requirement — you do
   not also need Trading Economics.

**Trading Economics — `ECONOMIC_CALENDAR_API_KEY`** (paid for real data)
1. [tradingeconomics.com/api](https://tradingeconomics.com/api) → **Get a
   Key** / **Contact Sales**.
2. Their free `guest:guest` demo credentials return sample data only —
   not usable for live trading. A real key requires a paid plan; check
   their current pricing before signing up.
3. If you do have a paid key, paste it into `ECONOMIC_CALENDAR_API_KEY=`.
   It runs *alongside* Finnhub if both are set — `evidence-aggregator.ts`
   merges every fresh source rather than requiring exactly one.

**Generic adapter — `ECONOMIC_EVIDENCE_ENDPOINT`**
Same pattern as the news generic adapter above — a URL you control,
returning the same normalized `{ observations: [...] }` shape.

## Optional supplementary evidence adapters (not required for live — `required: false`)

Two more generic normalized-evidence slots, wired in `run-mt5.ts` but
never mandatory: leave both blank to skip them entirely.

| Variable | How to get it |
|---|---|
| `DELTA_EVIDENCE_ENDPOINT` + `DELTA_API_KEY` | Base URL and key for whatever additional authorized evidence source you want to plug in under the name "delta" — not a specific named vendor this project integrates with by default. |
| `BINANCE_EVIDENCE_ENDPOINT` (+ `BINANCE_API_KEY`, shared with the market-data provider above) | Base URL for a Binance-derived evidence feed, if you have one beyond plain market data. |

## Python / model registry

| Variable | How to get it |
|---|---|
| `PYTHON_COMMAND` | Leave blank in almost every case — defaults to `py` on Windows, `python3` elsewhere. Only set this if your system's Python launcher is aliased differently. |
| `MODEL_STAGE` | Your own choice: `development`, `staging`, or `production`. Not fetched — it selects which folder under `models/` inference loads from. |

## ML switch, evidence/model safety thresholds

Not obtained from anywhere — these are behavior knobs you set based on how
conservative you want the system to be. Sensible starting defaults are
already in both `.env.*.local` files: `AI_MODE=ensemble`,
`AI_MIN_PROBABILITY=0.60`, `AI_MAX_UNCERTAINTY=0.45`,
`DECISION_MIN_CONFIDENCE=0.55`, `DRIFT_Z_THRESHOLD=3`, etc. `AI_ENABLED`
must be `true` for live trading (`env.ts`/`run-mt5.ts` both enforce this).

## Risk controls

Also not obtained from anywhere — review `.env.production.local`'s
defaults (`RISK_MAX_PER_TRADE_PCT=0.005`, `RISK_MAX_OPEN_POSITIONS=3`,
`RISK_MAX_DAILY_LOSS_PCT=0.03`, `RISK_MAX_DRAWDOWN_PCT=0.15`) against your
own account size and risk tolerance before going live — they're the
project's documented starting point, not a recommendation for you
specifically.

## Autonomous supplementary research / monitoring

Tuning knobs (poll intervals, alert thresholds, dashboard port) — working
defaults are already filled in both `.env.*.local` files; change only if
you have a specific reason to.

## Live activation

The one category that's deliberately hard to fill in by accident — see
`README_FILES/README.md`'s "Activating live trading" section before
touching any of these.

| Variable | How to get it |
|---|---|
| `LIVE_TRADING_ENABLED` | Set to `true` yourself, deliberately — not issued by anything. |
| `SYNTHETIC_TRADING_ENABLED` | Set to `true` only for explicitly confirmed deterministic orders on the connected MT5 account. |
| `SYNTHETIC_ACTIVATION_CONFIRMATION` | Must equal `I_UNDERSTAND_SYNTHETIC_ORDERS` in synthetic mode. |
| `LIVE_ACTIVATION_TOKEN` | Self-generated, ≥32 characters, e.g. `openssl rand -hex 32`. Never reuse `MT5_BRIDGE_SECRET` or any other secret for this — generate a fresh one. |
| `LIVE_ACTIVATION_CONFIRMATION` | Must be the exact literal string `I_UNDERSTAND_LIVE_TRADING` — you type this yourself as a second, separate confirmation; it's not a value anyone gives you. |
| `LIVE_REQUIRE_EVIDENCE` | Must stay `true` in live mode — `env.ts` throws if you set it to `false` while `TRADING_MODE=live`. There's no way to obtain a value that disables this gate. |
| `LIVE_KILL_SWITCH_FILE` | A filesystem path of your choosing that you can reach quickly in an emergency — creating that file (any content) halts new entries immediately without touching existing protective orders. |

---

Once you've filled in what your workflow needs, verify it loads:

```
NODE_ENV=development npx ts-node -e "import { env } from './src/config/env'; console.log('OK')"
NODE_ENV=production  npx ts-node -e "import { env } from './src/config/env'; console.log('OK')"
```

A missing *required* value throws immediately with the exact variable name
in the error — that's `env.ts` telling you what's still missing, not a
bug to work around.
