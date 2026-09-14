# MT5 Setup Guide

This is the complete walkthrough for connecting this bot to a real
MetaTrader 5 terminal — from attaching the EA to running your first paper
trade. Read **Section 0** first even if you're in a hurry: almost all
setup confusion comes from mixing up two folders that sound similar but
are completely different places.

- [0. The two folders you'll be working with](#0-the-two-folders-youll-be-working-with)
- [1. Copy the EA into MT5's folder](#1-copy-the-ea-into-mt5s-folder)
- [2. Compile the EA in MetaEditor](#2-compile-the-ea-in-metaeditor)
- [3. Attach the EA to a chart](#3-attach-the-ea-to-a-chart)
- [4. Configure the Node side (`.env`)](#4-configure-the-node-side-env)
- [5. Run it in paper mode](#5-run-it-in-paper-mode)
- [6. Get real historical data and retrain](#6-get-real-historical-data-and-retrain)
- [7. MongoDB](#7-mongodb)
- [8. External evidence (news / economic calendar)](#8-external-evidence-news--economic-calendar)
- [9. Going live](#9-going-live)
- [Troubleshooting](#troubleshooting)
- [Quick reference](#quick-reference)

---

## 0. The two folders you'll be working with

Everything in this guide happens in one of exactly two places. They have
similar-sounding names on purpose (both are "the MT5 folder" in casual
speech), but they are not the same folder, they're not related, and
nothing keeps them in sync automatically.

```
┌─────────────────────────────────────────────────────────────────────┐
│  FOLDER A — YOUR PROJECT (this repo)                                 │
│  Wherever you downloaded/unzipped this codebase, e.g.                │
│  C:\Users\you\AI-Trading-Bot\                                        │
│                                                                        │
│  AI-Trading-Bot\                                                     │
│  └── mt5\                                                            │
│      └── Experts\                                                    │
│          └── AITradingBot\                                           │
│              └── AITradingBot.mq5   ← the EA SOURCE FILE.            │
│                                        Already here. Nothing to       │
│                                        create. This is where it       │
│                                        lives permanently — you        │
│                                        never edit the copy in         │
│                                        Folder B, you always come      │
│                                        back here as the source of     │
│                                        truth.                         │
│                                                                        │
│  This folder is what `npm install`, `npm run build`, `npm run        │
│  run:mt5`, etc. all run from. It has nothing to do with MT5's own     │
│  file layout.                                                        │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  FOLDER B — MT5's OWN DATA FOLDER                                    │
│  A completely separate location that the MetaTrader 5                │
│  *application* manages, e.g.                                        │
│  C:\Users\you\AppData\Roaming\MetaQuotes\Terminal\<random-id>\       │
│                                                                        │
│  Terminal\<random-id>\                                               │
│  └── MQL5\                                                           │
│      └── Experts\                                                    │
│          └── AITradingBot\                                           │
│              └── AITradingBot.mq5   ← a COPY of the source file.     │
│                                        This is the copy MT5 actually  │
│                                        compiles and runs. You'll      │
│                                        paste the file here once, and  │
│                                        again any time the source in   │
│                                        Folder A changes.              │
│                                                                        │
│  You never type this path by hand — MT5's own File → Open Data       │
│  Folder menu command opens it for you (Section 1 below).             │
└─────────────────────────────────────────────────────────────────────┘
```

**The one-sentence version:** Folder A is your source code (already has
the file). Folder B is MT5's own folder (you paste a copy of the file
into it). After Section 1, the same `.mq5` file exists in both places —
that's correct and expected, not a mistake.

There is also a **third** location that only matters starting at Step 5,
and it's a different kind of folder again — not something you navigate
to, but a path MT5 *prints for you* in a log after the EA starts. That's
the **Common `Files` folder**, and it's how the EA and this Node project
talk to each other after setup is done. It's covered in Section 3, not
here, because you don't need it until the EA is already running.

---

## 1. Copy the EA into MT5's folder

1. Open MT5 and log in to the account you want to use — **start with a
   demo account**, not a live one, until everything below is working.
2. In the MT5 menu bar: **File → Open Data Folder**. This opens **Folder
   B** (MT5's own data folder) in a new File Explorer window. You do not
   type or construct this path yourself — MT5 opens it for you every
   time.
3. In that window, navigate into `MQL5\Experts\`. If a folder called
   `AITradingBot` doesn't already exist there, create it.
4. Now switch to a **second** File Explorer window pointed at **Folder
   A** — your project folder, where you unzipped or cloned this repo —
   and navigate to `mt5\Experts\AITradingBot\`.
5. Copy `AITradingBot.mq5` from Folder A and paste it into the
   `AITradingBot` folder you just created/opened inside Folder B.

At this point the same file exists in two places. That's correct: keep
the original in Folder A untouched (it's your project's source code —
if you ever update the EA, you'll edit it there and re-copy it into
Folder B), and the copy in Folder B is what MT5 will compile and run.

## 2. Compile the EA in MetaEditor

1. Open **MetaEditor** — there's a toolbar button for it inside MT5, or
   find it in your Start menu / Applications.
2. In MetaEditor's file navigator (left panel), find
   `Experts → AITradingBot → AITradingBot.mq5`. It shows up automatically
   because MetaEditor reads from the same Folder B you just copied into
   — you don't need to open it manually.
3. Click **Compile** (or press **F7**).
4. Check the output panel at the bottom: it should say **"0 errors"**.
   Warnings are fine; errors mean something went wrong in step 1 above
   (usually: the file landed in the wrong subfolder, or didn't fully
   copy) — see [Troubleshooting](#troubleshooting).

## 3. Attach the EA to a chart

1. Switch back to the MT5 application (not MetaEditor).
2. Open a chart for the symbol you intend to trade (e.g. **EURUSD**),
   on any timeframe — the EA's own timer drives its logic, not the
   chart's timeframe.
3. In MT5's **Navigator** panel (usually docked on the left; if it's not
   visible, **View → Navigator** or **Ctrl+N**), expand **Expert
   Advisors**. `AITradingBot` should appear there — this is read from
   Folder B, confirming the compile worked.
4. **Drag** `AITradingBot` from the Navigator onto the chart.
5. A settings dialog pops up. Go to the **Inputs** tab and set:
   - `InpBridgeSecret` — a random string of **at least 16 characters**,
     e.g. generate one with `openssl rand -hex 24` or any password
     generator. The EA refuses to start with the placeholder default.
     **Write this value down** — you'll need the exact same string for
     `MT5_BRIDGE_SECRET` on the Node side in Section 4.
   - Leave `InpMagicNumber` at its default (`26090601`) unless you have
     a specific reason to change it — if you do change it, it must match
     `MT5_MAGIC_NUMBER` on the Node side exactly.
6. On the **Common** tab, make sure **"Allow live trading"** and
   **"Allow DLL imports"** are checked if present (these vary slightly by
   MT5 build; the EA itself doesn't use DLLs, but some builds gate file
   access behind the live-trading checkbox).
7. Click **OK**.
8. Check for a smiley-face icon in the top-right corner of the chart —
   that means the EA is running. If it's a sad/frowning face instead, see
   [Troubleshooting](#troubleshooting).
9. Open the **Toolbox** panel (**Ctrl+T**) and click the **Experts** tab.
   You should see a line like:

   ```
   AITradingBot: bridge started. Magic=26090601 Common files path: C:\Users\you\AppData\Roaming\MetaQuotes\Terminal\Common\Files
   ```

   **Copy that exact path** — it's the third location mentioned in
   Section 0 (the Common `Files` folder), and it's what you'll set
   `MT5_COMMON_DIRECTORY` to in the next section. It uses `FILE_COMMON`
   internally, which is a folder **shared across every MT5 terminal
   installed on your machine** — not the per-terminal `MQL5\Files`
   folder you might see referenced elsewhere. Using the wrong one is the
   single most common connection failure; see
   [Troubleshooting](#troubleshooting).

## 4. Configure the Node side (`.env`)

Back in **Folder A** (your project folder), the environment loader uses
layered files at the repo root:

```text
.env.example             # committed template only — copy this, don't edit it directly
.env.development.local   # local development values, ignored by Git
.env.production.local    # production/paper deployment values, ignored by Git
```

`config/env.ts` selects the file based on `NODE_ENV`, loading
`.env.<NODE_ENV>.local` first and then `.env` for anything not already
supplied. Real process environment variables always win over both files.
**Never put real credentials in `.env.example`** — it's the only one of
these that's committed to version control.

Copy the template and fill in at minimum the MT5 block:

```powershell
Copy-Item .env.example .env.development.local
```

Then edit `.env.development.local`:

```text
NODE_ENV=development
TRADING_MODE=paper

MT5_ACCOUNT_ID=<your MT5 account number>
MT5_SERVER=<your broker's server name, exactly as shown in MT5 → Account tab>
MT5_COMMON_DIRECTORY=<the path the Experts log printed in Section 3, step 9>
MT5_BRIDGE_SECRET=<the exact same string you set as InpBridgeSecret in Section 3, step 5>
# Paper mode may leave these blank to adopt the EA chart identity.
MT5_SYMBOL=
MT5_TIMEFRAME=

MONGODB_URI=mongodb://localhost:27017
```

Paper mode simulates fills and never submits broker orders. To test the
complete deterministic strategy against the connected MT5 demo account,
use the separately gated synthetic mode:

```text
TRADING_MODE=synthetic
SYNTHETIC_TRADING_ENABLED=true
SYNTHETIC_ACTIVATION_CONFIRMATION=I_UNDERSTAND_SYNTHETIC_ORDERS
AI_ENABLED=false
```

Synthetic mode submits real orders to the connected MT5 account, so use a
demo account and keep all risk/data/reconciliation gates enabled. It does not
use a production ML model. Live mode remains the only mode permitted to use
production model artifacts.

Then set the environment variable for this shell session:

```powershell
$env:NODE_ENV = "development"
```

(On macOS/Linux: `export NODE_ENV=development`.)

**The two values most people get wrong:**
- `MT5_COMMON_DIRECTORY` must be copy-pasted from the Experts log, not
  typed from memory or guessed — see step 9 above.
- `MT5_BRIDGE_SECRET` must be character-for-character identical to
  `InpBridgeSecret` in the EA's Inputs tab. If you ever change one, you
  must change the other and re-attach/restart both sides.

## 5. Run it in paper mode

```powershell
npm install
npm run build
npm run run:mt5
```

With `TRADING_MODE=paper`, this connects to your real MT5 terminal via
the Common `Files` folder, pulls real candles and account state, runs the
full validation → features → decision → risk pipeline — but every order
goes only to `PaperExecutionAdapter`. **Nothing is ever sent to your
broker in this mode.** MongoDB must be reachable (Section 7); it's used
for durable order state and the audit log, not optional telemetry.

Each cycle prints one JSON `AuditRecord` line to the console. If you'd
rather watch a rolling status view, run `npm run dashboard` in a second
terminal and open `http://127.0.0.1:8787`.

**What to expect the first time:** you don't have a real trading model
yet at this point (the one shipped in `models/development/` was trained
on a synthetic sine wave — see `README_FILES/README.md`'s audit
section), so early paper runs are really just proving the MT5 connection
and pipeline work end-to-end. That's the correct thing to be checking
here — real signal comes after Section 6.

## 6. Get real historical data and retrain

Once `npm run run:mt5` is connecting successfully:

```powershell
# Pulls real closed candles from the connected MT5 terminal via the bridge
# and writes data/raw/EURUSD_M15_mt5.csv — never dev-synthetic.csv, the
# source tag in the filename makes the two impossible to confuse.
npx ts-node src/scripts/export-historical-data.ts EURUSD M15 6000

# Build features + labels from the real CSV, then retrain.
python ai/training/preprocessing/build_dataset.py data/raw/EURUSD_M15_mt5.csv
python ai/training/trainers/train_classifier.py
```

6000 M15 bars is roughly two months of data — MT5 demo accounts
typically only retain a limited chart history, so you may need to run
the export periodically and append rather than expecting years of
history in one pull.

Expect real walk-forward accuracy to be far lower than the synthetic
run's ~99.9%. Anything consistently above roughly 52–55% directional
accuracy on retail EURUSD is a meaningfully positive result, not a
disappointing one. **Do not** lower `MIN_DECISION_CONFIDENCE` in
`decision-engine.ts` just to make more trades fire — that threshold
exists to keep the bot in `NO_TRADE`/`INSUFFICIENT_CONFIDENCE` when the
model genuinely isn't sure, which is a feature, not a bug to work around.

A newly trained model lands in `models/development/`. It only reaches
`models/production/` (what `run:mt5` uses by default via `MODEL_STAGE`)
through the model registry's own promotion path (Section 9) — don't
hand-copy files between the stage folders. That guardrail exists on
purpose, and both `run-mt5.ts` and `preflight-live.ts` independently
re-verify a promoted model's quality metrics at startup specifically
*because* a hand-copy is still physically possible even though it isn't
the intended path.

## 7. MongoDB

`run:mt5` will not start without a reachable MongoDB instance — it's
required for durable order/account state and the audit log, not optional
telemetry. This doesn't require a paid service: install MongoDB
Community Server locally, or run the official `mongo` Docker image, and
point `MONGODB_URI` in your `.env.*.local` at it (e.g.
`mongodb://localhost:27017`).

## 8. External evidence (news / economic calendar)

The project supports the Alpha Vantage News & Sentiment and Trading
Economics Calendar adapters, plus normalized external HTTP endpoints. In
`paper` mode these may be omitted entirely. In `live` mode,
`LIVE_REQUIRE_EVIDENCE=true` requires both a news/sentiment source and an
economic-calendar source to be configured and returning real data — not
just a key being present. Evidence is timestamped, freshness-checked, and
fail-closed; it informs the decision engine but never has execution
authority on its own.

## 9. Going live

Live execution is code-enabled but deliberately hard to activate by
accident. See `README_FILES/README.md`'s **"Activating live trading"**
section for the full checklist of required environment variables — this
guide covers the MT5-specific pieces only:

```powershell
npm run train:dataset
npm run train:ensemble
```

The ensemble trainer keeps a chronological final out-of-sample block
completely out of walk-forward training, calibration, and meta-model
fitting. A candidate is never promoted automatically:

```powershell
npm run promote:model -- EURUSD M15 --confirm-production
```

Promotion enforces six quality gates (minimum OOS rows, an accuracy
floor, a Brier ceiling, a balanced-accuracy-beats-random check, and edges
over the majority-class and class-prior baselines) — see
`CHANGELOG.md`'s v6 entry for the full list. `run-mt5.ts` and
`preflight-live.ts` re-verify the same six gates independently at
startup, using the same shared, tested function
(`src/core/ai-bridge/model-quality-gate.ts`), so a model can't reach live
execution by any route without clearing all six.

Before enabling live execution, run the no-order preflight:

```powershell
npm run preflight:live
```

Only if that passes should the live runner be started:

```powershell
npm run run:mt5
```

`MT5_MAGIC_NUMBER` in your `.env` must match `InpMagicNumber` in the EA's
Inputs — this is the identity check that makes a mismatch show up as
"not connected" rather than silently trading with the wrong
configuration.

---

## Troubleshooting

**MetaEditor shows compile errors.**
Almost always means the file in Folder B (Section 1) is incomplete or in
the wrong subfolder. Delete the `AITradingBot` folder under
`MQL5\Experts\` in Folder B and redo Section 1 — copy the *entire* file
fresh from Folder A rather than trying to fix it in place.

**The chart shows a sad-face icon instead of a smiley after attaching the EA.**
Usually one of:
- `InpBridgeSecret` is still the default placeholder or under 16
  characters — the EA's `OnInit()` deliberately refuses to start in that
  case. Check the Experts log for the exact message.
- "Allow live trading" (or equivalent, varies by MT5 build) wasn't
  checked when attaching.
- **AutoTrading** is disabled globally — look for the AutoTrading toggle
  button in MT5's main toolbar; it must be green/enabled.

**Node can't connect / `run:mt5` hangs or times out.**
Check, in order:
1. `MT5_COMMON_DIRECTORY` — must be copied verbatim from the Experts log
   (Section 3, step 9), not typed or guessed. It's a shared
   `FILE_COMMON` folder, not the per-terminal `MQL5\Files` folder some
   other MT5 bridge projects use.
2. `MT5_BRIDGE_SECRET` must exactly match `InpBridgeSecret` — copy-paste
   both ends rather than retyping either.
3. The EA must still be attached and showing the smiley icon — if you
   closed the chart or MT5 restarted, the EA needs to be re-attached
   (MT5 usually restores it automatically on restart, but confirm the
   icon).

**"MT5 heartbeat failed or EA magic/account/server identity changed."**
This is the identity check working as intended, not a bug — it means one
of `MT5_MAGIC_NUMBER`, `MT5_ACCOUNT_ID`, or `MT5_SERVER` in your `.env`
doesn't match what the EA reports. Double-check `MT5_SERVER` especially:
copy it exactly from MT5's **Account** tab (it often has a suffix like
`-Demo` or a broker-specific name that's easy to mistype).

**Every request fails with "stale or invalid request" (or everything looks like it's "from the future"), even though Node and MT5 are both clearly running and the secret/magic/account all match.**
This was a real bug (fixed as of this audit pass): the EA compared the
request timestamp — which the Node bridge always stamps in true UTC — against
`TimeLocal()`, the MT5 terminal host's local wall-clock time with **no
timezone conversion at all**. If the machine running the MT5 terminal has
its system clock set to anything other than UTC+0, every single bridge
call (history, quotes, symbol specs, orders — all of them, live or paper)
would fail this check: either instantly ("future timestamp") if the host
runs ahead of UTC, or within seconds ("stale") if it runs behind. The fix
uses `TimeGMT()` instead, which converts using the OS's own timezone
settings and matches Node's `Date.now()` regardless of where the terminal
is hosted. If you're running an older copy of the EA and see this
symptom, recompile with the current `AITradingBot.mq5` and re-attach it.

**"broker rejected order" or "stop or target violates broker minimum/freeze distance" (paper mode only shows this as a risk-rejected `NO_TRADE`, not a broker error, but the underlying cause is the same).**
Different brokers/symbols enforce different minimum stop distances and
fill modes. This is exactly what "verify on your actual MT5
installation" in the top-level README's audit section refers to — it's
expected to need broker-specific verification, not a bug in the bot.

---

## Quick reference

| What | Where | How you get it |
|---|---|---|
| EA source file | Folder A: `mt5/Experts/AITradingBot/AITradingBot.mq5` | Already in this repo |
| EA compiled/run copy | Folder B: `<MT5 data folder>/MQL5/Experts/AITradingBot/AITradingBot.mq5` | Paste it there (Section 1) |
| MT5's data folder itself (Folder B) | Varies by machine | MT5 menu: **File → Open Data Folder** |
| Common `Files` folder (bridge exchange point) | Varies by machine, shared across terminals | Printed in the Experts log after the EA starts (Section 3, step 9) |
| `.env.development.local` | Folder A repo root | `Copy-Item .env.example .env.development.local`, then edit |
