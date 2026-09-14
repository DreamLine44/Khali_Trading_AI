# AI Trading Bot

Staged AI trading system for MetaTrader 5. The architecture is documented
in `docs/architecture/master-prompt.md`, and implemented slices are kept
separate from capabilities that still require production validation.

**Setting up MT5?** Go straight to
[`docs/mt5-setup.md`](docs/mt5-setup.md) — it's the complete,
step-by-step guide (including the folder layout that trips people up
most) for attaching the EA, configuring the bridge, and running your
first paper trade.

**Configuring environment variables?** See
[`ENVIRONMENT_VARIABLES.md`](ENVIRONMENT_VARIABLES.md) for where every
value in `.env.development.local`/`.env.production.local` actually comes
from — which ones you generate yourself, which come from a provider
signup, and which are just tuning knobs you decide.

**Just need the API keys?** [`../API_SETUP.md`](../API_SETUP.md) at the
repo root is a step-by-step, provider-by-provider walkthrough — MT5,
MongoDB, Twelve Data, Binance, Alpha Vantage, Finnhub, Trading Economics,
and the live-activation secrets — for exactly the variables in
`.env.example`.

## Status

The validated local slices include development, backtesting, AI inference,
multi-source evidence validation, and a real-time MT5 paper loop:

```
1. REAL-TIME MT5 PAPER LOOP:
   MT5 EA → VALIDATION → FEATURES + EXTERNAL EVIDENCE → PYTHON MODEL
     → DECISION → RISK → MONGODB ORDER STATE → PAPER EXECUTION → AUDIT

2. BACKTESTING ENGINE:
   HISTORICAL CANDLES → (bar-by-bar, no look-ahead) → FEATURE ENGINE
       → DECISION ENGINE → RISK ENGINE → SIMULATED FILL (spread +
       slippage + commission) → TRADE LEDGER → METRICS

3. AI TRAINING/INFERENCE PIPELINE:
   RAW CANDLES (CSV) → DATASET BUILDER (labeled, embargoed) →
       WALK-FORWARD TRAINING (calibrated classifier) → MODEL REGISTRY
       (development/staging/production/archived) → INFERENCE →
       NODE↔PYTHON BRIDGE
```

Run everything:

```bash
npm install
# Python 3.11+ is required: the checked-in joblib model uses scikit-learn 1.9.0.
# Windows: create/select .venv with `py -3.11 -m venv .venv`, then install:
py -3.11 -m venv .venv
.venv\\Scripts\\python.exe -m pip install -r requirements.txt

npm run run:slice                              # (1) one live-loop pass, dev data + paper execution
npx ts-node src/scripts/run-backtest.ts       # (2) backtest over synthetic history
npx ts-node tests/backtesting/engine.test.ts  # backtest engine mechanics tests

npx ts-node src/scripts/export-historical-data.ts    # writes data/raw/*.csv
py -3.11 ai/training/preprocessing/build_dataset.py   # writes data/processed/*_features.csv
py -3.11 ai/training/trainers/train_classifier.py     # writes models/development/*
py -3.11 -m pytest tests/ai                         # AI pipeline tests

npx ts-node src/scripts/check-python-bridge.ts # (3) proves the Node↔Python boundary works
```

TypeScript application code is grouped under `src/`:

```text
src/
├── config/       environment loading
├── core/         market data, features, evidence, decisions, risk, bridges
├── execution/    paper/MT5 adapters, orders, reconciliation
├── backtesting/  engine, costs, metrics, reports
├── database/     MongoDB repositories and audit storage
└── scripts/      runnable TypeScript entry points

ai/               Python training, inference, validation
mt5/              MQL5 Expert Advisor and bridge code
data/             raw and processed datasets
models/           development, staging, production artifacts
tests/            TypeScript and Python tests
README_FILES/     this file, docs/, CHANGELOG.md, ENVIRONMENT_VARIABLES.md
```

The commands above are the validation workflow. Successful execution
depends on Node.js, installed npm dependencies, Python, and the packages
listed in `requirements.txt`; this README does not claim that every
command has run successfully in every environment.

### What's real right now

- **Data validation** (`src/core/market-data/normalizers/candle-validator.ts`):
  missing/duplicate/non-finite values, OHLC consistency, timestamp
  monotonicity, gaps, staleness. A failing check produces `NO_TRADE`.
- **Indicators** (`src/core/features/indicators.ts` and the Python
  equivalents in `ai/training/preprocessing/build_dataset.py`): SMA,
  EMA, RSI, ATR — return `null`/`NaN`-dropped on insufficient history,
  never silently 0.
- **Decision gating** (`src/core/decision/decision-engine.ts`): confidence
  thresholding, model-disagreement rejection, data-quality veto,
  separate regime-confidence gate (fixed to not double-penalize).
- **Risk engine** (`src/core/risk/risk-engine.ts`): drawdown/daily-loss/
  exposure/margin/spread-vs-ATR checks, ATR-based stop distance and
  position sizing computed from the real entry price. Veto power — the
  decision engine cannot bypass it.
- **Order state machine + idempotency** (`src/execution/orders/order-manager.ts`).
- **Paper execution adapter** — no real orders are ever sent.
- **Audit trail** — MongoDB is the required production audit/state store,
  with one immutable record per decision. The current vertical slice uses
  an explicitly development-only JSONL adapter until MongoDB is configured.
- **Backtesting engine** (`src/backtesting/engine/backtest-engine.ts`):
  bar-by-bar replay, structurally prevents look-ahead (the predictor
  function only ever sees candles up to the current bar), realistic
  spread/slippage/commission (`backtesting/costs/cost-model.ts`),
  single-position state machine with stop/target checks against
  intrabar high/low, forced close at end of data. Verified by
  `tests/backtesting/engine.test.ts` against P&L math, not just "it ran."
- **Metrics** (`backtesting/metrics/metrics.ts`): win rate, profit
  factor, expectancy, max drawdown, consecutive losses, an approximate
  Sharpe — more than just win rate, per spec section 26.
- **Dataset builder** (`ai/training/preprocessing/build_dataset.py`):
  explicit label definition (forward return over a fixed horizon),
  explicit embargo requirement documented and enforced in the
  walk-forward split so the label horizon can't leak across folds.
- **Walk-forward validation** (`ai/validation/walk_forward.py`):
  expanding-window, chronological, embargoed — no shuffling.
- **Calibrated model training** (`ai/training/trainers/train_classifier.py`):
  gradient-boosted classifier wrapped in isotonic calibration, evaluated
  out-of-fold (accuracy, log loss, multiclass Brier score), a final
  artifact retrained on all data but whose quality claim rests entirely
  on the walk-forward numbers, not the final fit.
- **Model registry** (`ai/common/config.py`, `ai/common/model_loader.py`):
  versioned artifacts with a metadata sidecar (training source, row
  count, fold metrics); loading a stage that has no model raises
  `ModelNotAvailableError` rather than falling back — verified by test.
- **Inference + Node↔Python bridge** (`ai/inference/prediction.py`,
  `core/ai-bridge/python-model-bridge.ts`): produces a `ModelPrediction`-
  shaped output (action/probability/uncertainty) callable as a
  subprocess from Node; fail-safe behavior confirmed end-to-end from a
  TypeScript caller through to the Python exception.

### Remaining external production requirements

- `DevMarketDataProvider` remains test-only synthetic data.
- MT5 data, account snapshots, reconciliation, and the supervised paper
  loop are implemented. MetaEditor compilation and broker-specific testing
  must be performed on the user's MT5 installation.
- **The trained model is a pipeline validity check, not a trading
  model.** It was trained on `dev-synthetic` data — its 99.9% walk-forward
  accuracy reflects how trivially learnable a deterministic synthetic
  sine wave is, not real predictive edge. Every artifact carries this
  in its metadata (`training_data_source: "dev-synthetic"`) and the
  trainer prints an explicit warning. It must never be promoted past
  `models/development/`.
- Regime detection is an objective conservative baseline. It still needs
  real-data validation before it is trusted as a production edge.
- The standalone backtest command still uses an explicitly labeled
  RSI-threshold predictor. Model-backed historical evaluation must use a
  separate batch-scoring workflow so subprocess latency does not distort
  the simulation; it is not represented as a validated production result.
- External Delta/Binance/news/calendar feeds are supported through
  authorized endpoints returning the normalized evidence contract in
  `docs/market-data.md`; credentials and provider licensing remain
  deployment prerequisites.
- Live broker order submission remains deliberately disabled in
  `run-mt5.ts` until sustained MT5 demo testing and operational approval.
- Model drift monitoring, dashboard/API, and automated candidate promotion
  are not yet implemented.

## Build order and release status

Per spec section 40A, this sequence is gated by evidence and is not a
claim that every subsystem is complete:

1. ✅ Vertical slice with dev data + paper execution.
2. ✅ Backtesting engine with realistic costs and no look-ahead
   (real MT5/vendor data ingestion still pending — spec 6A split is
   architected via provider stubs, not yet connected to live credentials).
3. 🔶 AI training/validation/inference pipeline — wired into the MT5
  paper loop, but the checked-in artifact is dev-synthetic and cannot be
  promoted to production.
4. News/economic-calendar/sentiment interfaces: normalized authorized
  provider contract implemented; deployment feeds still required.
5. MT5 execution adapter, paper trading against real live data.
6. Live trading — explicit opt-in only, small size, full monitoring.

## Repo layout

See `docs/architecture/master-prompt.md` for the governing spec, and
inline comments in each module for what's real vs. placeholder there.

## Added intelligence layers

The current source tree now includes an expanded feature layer (WMA, MACD,
Stochastic, ROC, Bollinger Bands, historical volatility, VWAP, OBV), objective
candlestick-pattern recognition, market-structure/CHoCH features, a calibrated
three-model ensemble trainer, ensemble disagreement/entropy uncertainty,
production provenance guards, and a lightweight drift detector. The decision
engine treats these as independent confluence evidence; AI predictions alone
cannot authorize an entry.

Live external news/economic/sentiment data remains provider-configurable. The
system requires authorized normalized endpoints and does not fabricate live
evidence when credentials are missing.

## ML ensemble

The recommended ML configuration is a calibrated ensemble of XGBoost (primary), LightGBM (secondary), and Random Forest (diversity), followed by an out-of-fold logistic-regression meta-model. The meta-model is trained only on walk-forward out-of-fold predictions to avoid stacking leakage. The artifact remains a development candidate until it has passed the project's real-data, out-of-sample, cost-aware and paper-trading gates.

## Path to live trading, step by step

This is the full sequence from "cloned the repo" to "live trading",
in order. Don't skip ahead — each step's output is required input for
the next one, and the code enforces most of that itself (it will refuse
to run rather than silently skip a prerequisite).

**Where you actually are right now:** step 1. The only model in this
repo (`models/development/`) was trained on synthetic data — every gate
downstream correctly refuses to treat it as real, so steps 1–5 aren't
optional groundwork, they're the actual blocker.

### Step 1 — Get real historical data

```bash
npx ts-node src/scripts/export-historical-data.ts [SYMBOL] [TIMEFRAME] [COUNT]
# e.g.
npx ts-node src/scripts/export-historical-data.ts EURUSD M15 6000
```

Set `VENDOR_DATA_PROVIDER=mt5` (with the MT5 env vars from the paper-mode
section below) to pull from your real MT5 terminal, or point it at a
research provider (`twelvedata` / `binance`) with the matching API key.
There is no synthetic fallback in this script — it fails rather than
substituting fake data. Output lands in `data/raw/` and the filename
itself records the real source, so you can never mistake it for a dev
export.

### Step 2 — Build the training dataset

```bash
python3 ai/training/preprocessing/build_dataset.py
```

Reads the CSV from step 1, computes the full feature set (indicator
parity with the live TS engine), and writes labeled, embargoed data to
`data/processed/`.

### Step 3 — Train

```bash
python3 ai/training/trainers/train_classifier.py
```

Runs the calibrated ensemble (XGBoost + LightGBM + Random Forest + a
logistic-regression meta-model) through walk-forward, expanding-window,
embargoed validation — never a shuffle-based split, since that would
leak future information into training. Writes an artifact and a
metadata JSON sidecar to `models/development/`.

### Step 4 — Check whether it actually qualifies

Open the metadata JSON next to the new artifact and check it against
the same gates the code enforces later (`model_loader.py`,
`promote_model.py`, `preflight-live.ts`, `run-mt5.ts` all check these
independently):

- `training_data_source` is real — not `dev-synthetic`, `synthetic`,
  `unknown`, or empty.
- `metrics.final_oos_rows >= 200`.
- `metrics.oos_meta_accuracy` beats `metrics.oos_majority_accuracy_baseline`
  by at least 2 percentage points.
- `metrics.oos_meta_brier` beats `metrics.oos_brier_prior_baseline`.

**If it doesn't clear these, the answer is back to steps 1–3** — more
or better data, different features, different hyperparameters — not
forcing it through step 5. Every later gate will reject it anyway; this
step just lets you find that out without touching a live account.

### Step 5 — Promote it

```bash
python3 ai/validation/promote_model.py
```

Re-checks every gate from step 4 itself (it doesn't trust that you
checked correctly) and, only if they all pass, copies the artifact and
metadata into `models/production/`.

### Step 6 — Paper trade it for real

See "Running in paper mode" below. Run it against your real MT5 feed and
real evidence providers — not synthetic data — for a real stretch of
time, across a range of market conditions, and actually read the
`NO_TRADE` reasons it logs, not just the trades it takes. This is where
you find out whether the walk-forward numbers from step 4 hold up
outside the training pipeline.

### Step 7 — Go live

See "Activating live trading" below. This is the last step, and the one
with the least room for skipping checks — it requires everything from
steps 1–6 to already be true, plus its own separate activation lock.

## Running in paper mode

Paper mode runs the entire real pipeline — MT5 real-time data, feature
engine, evidence providers, model inference, decision engine, risk
engine — against a real MT5 connection, but **`PaperExecutionAdapter`

simulates fills instead of sending orders to the broker**. This is the
way to validate the whole system end-to-end with zero execution risk.

1. Set the shared prerequisites (MongoDB, MT5 bridge, model):

   ```bash
   MONGODB_URI=mongodb://localhost:27017
   MT5_ACCOUNT_ID=<your MT5 account id>
   MT5_SERVER=<your broker's server name>
   MT5_COMMON_DIRECTORY=<path to the MT5 terminal's Common\Files folder>
   MT5_BRIDGE_SECRET=<a shared secret matching the EA's config>
  # Paper mode can leave these blank to use the EA chart identity.
  MT5_SYMBOL=
  MT5_TIMEFRAME=
   ```

2. Set the mode:

   ```bash
   TRADING_MODE=paper
   ```

3. Run it:

   ```bash
   npx ts-node src/scripts/run-mt5.ts
   ```

Paper mode does **not** require `NODE_ENV=production`,
`LIVE_TRADING_ENABLED`, `LIVE_ACTIVATION_TOKEN`,
`LIVE_ACTIVATION_CONFIRMATION`, or `LIVE_REQUIRE_EVIDENCE` — none of the
live-activation lock applies. Watch `console.log` output each cycle (one
JSON `AuditRecord` per cycle) and, optionally, the dashboard
(`npx ts-node src/dashboard/server.ts`, then open
`http://127.0.0.1:8787`) for a rolling status view.

Stay in paper mode until you've watched it run through a real range of
market conditions and are reading and understanding every `NO_TRADE`
reason it logs — not just the trades it takes.

## Activating live trading

Live trading sends real orders to your broker through MT5. Everything
below is a deliberate, hard-to-clear-by-accident lock — see "Why these
checks exist" if you're wondering why any one of them is there.

**Live mode will refuse to start unless every one of these is true:**

| Variable | Required value |
|---|---|
| `NODE_ENV` | `production` |
| `TRADING_MODE` | `live` |
| `LIVE_TRADING_ENABLED` | `true` |
| `LIVE_ACTIVATION_TOKEN` | a real secret, 32+ characters |
| `LIVE_ACTIVATION_CONFIRMATION` | exactly `I_UNDERSTAND_LIVE_TRADING` |
| `LIVE_REQUIRE_EVIDENCE` | `true` |
| `AI_ENABLED` | `true` |
| `MODEL_STAGE` | `production` |

Plus, at least one news/sentiment provider and one economic-calendar
provider credential (`ALPHA_VANTAGE_API_KEY` and/or
`NEWS_EVIDENCE_ENDPOINT`; `FINNHUB_API_KEY` and/or
`ECONOMIC_CALENDAR_API_KEY` and/or `ECONOMIC_EVIDENCE_ENDPOINT`), since
`LIVE_REQUIRE_EVIDENCE=true` enforces that both categories are present.
`FINNHUB_API_KEY` is the free option for the economic-calendar category —
`ECONOMIC_CALENDAR_API_KEY` (Trading Economics) needs a paid plan for real
data.

### Steps

1. **Generate a real activation token.** Don't hand-type one — use
   something like:

   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```

   Store the result as `LIVE_ACTIVATION_TOKEN` in your live environment's
   secrets, not in a shared `.env` file used by other environments.

2. **Set the full live environment:**

   ```bash
   NODE_ENV=production
   TRADING_MODE=live
   LIVE_TRADING_ENABLED=true
   LIVE_ACTIVATION_TOKEN=<the token you generated>
   LIVE_ACTIVATION_CONFIRMATION=I_UNDERSTAND_LIVE_TRADING
   LIVE_REQUIRE_EVIDENCE=true
   AI_ENABLED=true
   MODEL_STAGE=production
   MONGODB_URI=mongodb://<your production Mongo>
   MT5_ACCOUNT_ID=<your MT5 account id>
   MT5_SERVER=<your broker's server name>
   MT5_COMMON_DIRECTORY=<path to the MT5 terminal's Common\Files folder>
   MT5_BRIDGE_SECRET=<a shared secret matching the EA's config>
  MT5_SYMBOL=<explicit production model symbol>
  MT5_TIMEFRAME=<explicit production model timeframe>
   ALPHA_VANTAGE_API_KEY=<your key>       # or NEWS_EVIDENCE_ENDPOINT
   FINNHUB_API_KEY=<your key>             # free; or ECONOMIC_CALENDAR_API_KEY/ECONOMIC_EVIDENCE_ENDPOINT
   ```

3. **Put a real, walk-forward-qualified model in `models/production/`.**
   It must exist there already — `run-mt5.ts` and `preflight-live.ts`
   both refuse to start without one — and it must pass every gate below
   (see the "Model isn't real" gap in the audit section — this is the
   biggest blocker right now):
   - `training_data_source` metadata is not `dev-synthetic` / `synthetic`
     / `unknown` / empty.
   - `symbol` and `timeframe` in the metadata match `MT5_SYMBOL` /
     `MT5_TIMEFRAME`.
   - `final_oos_rows >= 200`.
   - `oos_meta_accuracy` beats `oos_majority_accuracy_baseline` by at
     least 2 percentage points.
   - `oos_meta_brier` beats `oos_brier_prior_baseline`.

4. **Run the preflight check — do not skip this:**

   ```bash
   npx ts-node src/scripts/preflight-live.ts
   ```

   This independently re-checks every gate above, MT5 heartbeat/identity
   (magic number, account, server), and that reconciliation between
   Mongo's durable order state and the broker's actual positions is
   clean. It prints `{"ok": true, ...}` and exits 0 only if everything
   passes — anything else means don't proceed.

5. **Start it:**

   ```bash
   npx ts-node src/scripts/run-mt5.ts
   ```

6. **Know where the kill switch is before you need it.** Creating the
   file at `LIVE_KILL_SWITCH_FILE` (defaults to `LIVE_KILL_SWITCH` in
   the project root) makes the running process stop opening new
   positions on its very next cycle, without killing the process itself
   — it keeps reconciling and monitoring existing positions:

   ```bash
   touch LIVE_KILL_SWITCH
   ```

   Delete that file to resume.

7. **Watch the first sessions closely.** Tail the console output (one
   JSON audit record per cycle) and the dashboard. The process also
   self-stops after 3 consecutive cycle failures (its own safety circuit
   breaker) — if that happens, don't just restart it; read why it failed
   first.

### Why these checks exist

None of them affect whether a *good* trade gets taken once the bot is
running — they only gate whether the process is allowed to start in
live mode at all:

- `NODE_ENV=production` — keeps a dev/debug build off a real account.
- `LIVE_TRADING_ENABLED` — a master switch ops can flip off without a
  redeploy.
- `LIVE_ACTIVATION_TOKEN` — proves the process has access to real
  deployment secrets, not just a copy of the repo.
- `LIVE_ACTIVATION_CONFIRMATION` — a human typing that they understand
  real money is now at stake, to catch an accidentally-live `.env`.
- `LIVE_REQUIRE_EVIDENCE` — stops live mode from running with the
  external evidence layer silently absent.

## Audit: gaps to close before trading live

This is the state of the codebase as of this audit, organized by how
much it matters before real money is involved. Everything under
"Blocking" must be resolved — the bot enforces most of these itself and
will refuse to start otherwise, but a couple require a decision you have
to make, not just a config value.

### Blocking — the bot will not start, or will start unsafely, without these

1. **There is no real trading model.** The only artifact in
   `models/development/` was trained on deterministic synthetic data
   (`training_data_source: "dev-synthetic"`). Its 99.9% walk-forward
   accuracy reflects how trivial a synthetic sine wave is to predict,
   not real edge. `promote_model.py` and both live-startup checks
   (`run-mt5.ts`, `preflight-live.ts`) will refuse to treat it as
   production-grade — correctly. **You need to build a real dataset from
   real MT5/vendor history, train, walk-forward validate, and promote a
   model that actually clears the OOS-accuracy and Brier gates before
   `MODEL_STAGE=production` can point at anything real.**
2. **No production model exists in `models/production/` at all.** Even
   once you have a qualified model, `promote_model.py` has to be run to
   put it there — `run-mt5.ts` and `preflight-live.ts` both hard-fail
   without one.
3. **MT5 side (EA + bridge) needs testing on your actual broker/terminal.**
   The Node↔file-bridge protocol and MQL5 EA are implemented, but
   MetaEditor compilation, the file-bridge round trip, and broker-specific
   behavior (symbol suffixes, execution/fill mode, freeze/stops level)
   have to be verified on your real MT5 installation — ideally against a
   demo account first.
4. **Live news/economic-calendar credentials aren't configured yet.**
   `LIVE_REQUIRE_EVIDENCE=true` means live mode won't start without both
   a working news/sentiment provider and a working economic-calendar
   provider. Get real API keys (Alpha Vantage + Finnhub — both free — or
   Trading Economics if you have a paid plan, or your own authorized
   endpoints) and confirm they return real data, not just that the key is
   present. See `README_FILES/ENVIRONMENT_VARIABLES.md` for step-by-step
   signup instructions for each.
### Should do before committing real size

5. **You haven't run it in paper mode yet against your real MT5 feed and
   real evidence providers** (see the paper-mode section above). Do this
   for a real stretch of time, across a range of market conditions,
   before flipping to live.
6. **The standalone backtest command uses a placeholder RSI-threshold
   predictor, not your actual model.** Model-backed historical
   evaluation needs a separate batch-scoring workflow (subprocess
   latency would distort a live simulation) — until that exists, your
   backtest results say nothing about your actual model's edge.
7. **Regime detection is a conservative placeholder**, not yet validated
   against real data as a genuine production signal.
8. **Decide your real risk limits.** `DEFAULT_RISK_LIMITS` in
   `risk-engine.ts` (1% risk/trade, max 3 open positions, 3% daily loss,
   15% max drawdown, spread ≤ 50% of ATR) are reasonable starting
   defaults, not a recommendation for your account size or risk
   tolerance — review and set them deliberately via `riskLimits` in
   `run-mt5.ts` before going live.
9. **`MongoAuditLog`/`MongoOrderStore`/`MongoAccountStore` need a real,
    backed-up, monitored MongoDB instance in production** — not the
    dev-only JSONL fallback, and not an unmonitored local instance you
    might lose.

### Already solid — verified this audit, not just read-through

Data validation, evidence-quality gating, decision-engine gating, risk
sizing (ATR-based stops, broker-authoritative volume), order-lifecycle
idempotency and state transitions, reconciliation (including recovery of
timed-out-but-filled orders), execution confirmation requirements, the
MT5 file-bridge protocol's timeout/failure handling, `Mt5MarketDataProvider`'s
own identity verification (magic number/account/server — previously
delegated entirely to the caller re-checking separately, now enforced
by the class itself), and the live-mode startup lock itself have all
been read against real failure scenarios and fixed where gaps were
found (see `CHANGELOG.md`'s v3–v6 entries for the specific fixes and
regression tests).

**Latest pass (v16):** `DriftMonitor` and `AutomaticMarketDataOrchestrator`
test coverage — the last two items this section used to list as open —
are now both closed. See `CHANGELOG.md` for the full history and current
state.

