# Audit history

This is the consolidated record of every audit pass this project has been
through — previously scattered across ten separate `AUDIT_NOTES_v*.md`
files (v3–v8, v13–v16; v9–v12 were intermediate merge points with no
independent findings of their own, folded into the entries below). Each
entry is what that pass actually found and fixed, condensed to drop the
"still open / re-verified again" boilerplate every file repeated — that
status is tracked once, at the bottom, in **Current state**.

---

## v29 — env-loading safety, and a dead/misleading config duplicate

Continuation of the same systematic pass: cross-referenced every field in the exported `env` object against every actual `env.X` reference in the codebase (not just grepped for the field name — traced each candidate to its real call site) to find config that looks wired in but isn't, then checked doc-comments against what the code they describe actually does.

**Fixed: `getPythonModelPrediction()` had no timeout.** Every other external call on the entry-decision path (every HTTP evidence/market-data provider, the MT5 file bridge) enforces one and fails closed; the Python inference subprocess — the one dependency that actually produces the trading signal — did not. A stalled model load or a wedged interpreter would block the live trading loop's `await` indefinitely, with no self-recovery; only an external staleness monitor could notice, and only after the fact. Added `runPythonProcess()` with a SIGTERM-then-SIGKILL watchdog (`PYTHON_BRIDGE_TIMEOUT_MS`, default 20000ms), plus a regression test that spawns a process which ignores SIGTERM and asserts it's still force-killed and the promise still settles.

**Fixed: `env.ts` silently let a stale shell/system environment variable shadow a `.env` file's value with zero indication why.** `override: false` on the dotenv loader is correct by design (a real environment variable should be able to take precedence over a file), but it did so silently — a leftover `TRADING_MODE=dev` in a Windows session made `.env.development.local`'s `TRADING_MODE=paper` be ignored entirely, producing a confusing downstream error that looked like a bad `.env` file. `env.ts` now snapshots the real environment before loading any file and warns, by name, with both values, whenever this happens — for every `.env` file loaded, not just one. Regression test added.

**Bug found: `env.modelMaxUncertainty`/`env.modelMinProbability` were dead, misleading duplicate config.** `decision-engine.ts` gates on `env.aiMinProbability`/`env.aiMaxUncertainty` only, which read `AI_MIN_PROBABILITY`/`AI_MAX_UNCERTAINTY` with `MODEL_MIN_PROBABILITY`/`MODEL_MAX_UNCERTAINTY` as documented legacy fallback defaults. Separately, `env.ts` re-parsed those same two legacy vars into their own standalone exported fields that nothing in the codebase ever read. Net effect: setting `MODEL_MAX_UNCERTAINTY` while `AI_MAX_UNCERTAINTY` was already set looked like tightening a second, independent gate — it did nothing, silently. `.env.example`'s own comment on this section ("AI_* values take precedence when both are set") was actually accurate; the bug was purely the dead code, not the docs. Removed the dead fields.

**Bug found: a stale, factually false doc-comment on `swingHighLow()`.** It was marked "placeholder ... before this feeds real decisions," but `feature-engine.ts` already wires its output directly into `swingHigh`/`swingLow`, real `FeatureSet` fields — confirmed by tracing every consumer, not assumed. Checked whether this was also a functional train/inference-mismatch bug (the more serious possibility): it isn't — `build_dataset.py`'s `FEATURE_COLUMNS` never includes raw `swing_high`/`swing_low`, only the shift(1)-based derived fields (`swing_high_dist`, etc.), which the TS side already correctly sources from `priorSwingHighLow`, not this function. `decision-engine.ts`'s only use of the raw fields is a finite-number data-quality check, not a trading input. So the algorithm and the training/inference parity were both already correct — only the comment was wrong. Corrected it to state what's actually true, with the same train/inference-parity warning `priorSwingHighLow`'s (accurate) comment already carries.

**Verified, not just assumed:** `model-quality-gate.ts`'s comment claims its five thresholds "match `ai/validation/promote_model.py` exactly" — checked each of the five (`MIN_OOS_ROWS`, `MIN_OOS_ACCURACY_FLOOR`, `MAX_OOS_BRIER_CEILING`, `MIN_BALANCED_ACCURACY`, `MIN_OOS_ACCURACY_EDGE`) against the Python file's literals and comparison directions; all five match. No empty/silent `catch` blocks found anywhere in `src/`. `monitor.ts`'s alert doc-comment ("prints to stdout and appends to alerts.log") matches its actual behavior exactly — no overclaimed notification channel.

Re-ran `tsc --noEmit`, the full `npm run test:ts` (now 22 suites, +2 new), and `pytest tests/ai` (15 tests) before and after every change in this pass.



Full re-read of every market-data and evidence source end-to-end (`mt5-file-bridge.ts`, `mt5-market-data.provider.ts`, `twelve-data-market-data.provider.ts`, `binance-market-data.provider.ts`, `vendor-market-data.provider.ts`, `dev-market-data.provider.ts`, `provider-registry.ts`, `automatic-market-data-orchestrator.ts`, `candle-validator.ts`, `alpha-vantage-news.provider.ts`, `finnhub-economic-calendar.provider.ts`, `trading-economics-calendar.provider.ts`, `authorized-http-provider.ts`, `evidence-aggregator.ts`, `evidence-service.ts`, `cached-evidence-provider.ts`, `python-model-bridge.ts`, `export-historical-data.ts`, `reconciliation.ts`, `env.ts`), plus the MQL5 EA's response-writing code compared field-by-field against every TS-side parser (not assumed — traced each `StringFormat` call site against its corresponding `fields.length` check). Also independently re-ran `tsc --noEmit`, the full `npm run test:ts` (20 suites) and `pytest tests/ai` (15 tests) before touching anything, to verify v23's claimed clean state was real rather than re-asserted.

**Found one real, severe bug that had gone undetected through 23 prior passes:** `Mt5FileBridge.getPositions()` expected 11 fields per `"P"` position line, but `AITradingBot.mq5`'s `HandlePositions()` actually writes 10 (`P|ticket|magic|side|volume|open_price|stop_loss|take_profit|symbol|comment`). Every non-empty `POSITIONS` response was therefore rejected as `"MT5 returned malformed position data"`. Separately, when there are zero open positions — the normal, majority-of-the-time account state — `HandlePositions()` wrote no lines at all, and `Mt5FileBridge.request()`'s generic empty-response check (`"MT5 returned an empty response"`, correct for every other operation) rejected that too. Together these meant `getPositions()` threw in **every** account state, on **every** call.

This is on the hot path: `reconcileOrders()` calls `bridge.getPositions()` via `Promise.all(...)` on every single trading cycle in both paper and live mode, and `run-mt5.ts`'s *initial* reconciliation call (before the main loop, not wrapped in the per-cycle try/catch) would have thrown immediately on startup and crashed the process via the top-level `main().catch()` — meaning the bot could never have successfully started against a real MT5 terminal, in any account state, despite every other data channel and every existing test passing.

Root cause of the miss: `tests/unit/reconciliation.test.ts` mocks `bridge.getPositions()` directly, and `tests/integration/mt5-file-bridge.test.ts` (the one test exercising the real wire protocol) never sent a `POSITIONS` request — so the actual field-parsing logic for this one operation had zero real coverage across all 23 prior passes.

Fixed both sides:
- `mt5-file-bridge.ts`: field-count check corrected from 11 to 10 (verified against the EA's exact `StringFormat` argument list).
- `AITradingBot.mq5`'s `HandlePositions()`: now writes a `"{request_id}|OK|NONE"` sentinel line when `PositionsTotal()==0`, so the response is never empty. The sentinel carries no `"P"` marker, so `getPositions()`'s existing `fields[0]==="P"` filter correctly turns it into `[]` rather than a position record — no consumer-side change needed.
- New regression test `testGetPositionsParsesRealEaWireFormat` in `tests/integration/mt5-file-bridge.test.ts`, covering both the zero-position sentinel and a populated multi-position response against the bridge's real (unmocked) parser. Verified it fails against the pre-fix code (reproduced the exact original bug on purpose, confirmed the test catches it) before confirming it passes post-fix.

Everything else held up under independent re-verification: the v23 evidence-partial-outage fix, the Finnhub economic-calendar addition, and every other market-data/evidence provider's request formatting and response parsing were all confirmed correct against current provider documentation and the actual EA wire format. Full `npm run test:ts` (21 suites, including the new one), `pytest tests/ai` (15 tests), and `tsc --noEmit` all pass clean after the fix.

Added `API_SETUP.md` at the repo root: a consolidated, step-by-step "how do I actually get this key" guide for every provider referenced in `.env.example`, cross-checked against each provider's current signup flow and API documentation (not just restated from memory).

## v23 — systematic data-channel audit; found and fixed a partial-outage bug in evidence collection, added a free economic-calendar source

Full read-through of every market-data and evidence provider (`mt5-file-bridge.ts`, `mt5-market-data.provider.ts`, `twelve-data-market-data.provider.ts`, `binance-market-data.provider.ts`, `vendor-market-data.provider.ts`, `automatic-market-data-orchestrator.ts`, `candle-validator.ts`, `alpha-vantage-news.provider.ts`, `trading-economics-calendar.provider.ts`, `authorized-http-provider.ts`, `evidence-aggregator.ts`, `evidence-service.ts`, `cached-evidence-provider.ts`) plus the trading-loop integration points that consume them.

Found one real bug: `collectEvidence()` in `evidence-service.ts` returned immediately on a `required: true` provider's failure, discarding every observation already collected from other providers earlier in the same cycle and never calling providers still queued after it. With more than one source configured per category — the whole point of adding redundant providers — a single transient outage in one required source (e.g. Trading Economics) silently zeroed out evidence from every other healthy source too (e.g. Alpha Vantage, Finnhub). Fixed so a required-provider failure is still recorded (unchanged: visible in `quality.invalidSources`/`quality.unavailableSources`) without discarding data other sources already proved was good. New regression test: `testRequiredProviderFailureDoesNotDiscardOtherSources` in `tests/unit/evidence.test.ts`.

Added `finnhub-economic-calendar.provider.ts` — a free, real-data economic-calendar source (Finnhub's `/calendar/economic`), wired into `run-mt5.ts` and `preflight-live.ts` behind `FINNHUB_API_KEY`, running alongside Trading Economics rather than replacing it. This closes the one paid dependency in the required-for-live evidence set: `ALPHA_VANTAGE_API_KEY` + `FINNHUB_API_KEY` now satisfies `LIVE_REQUIRE_EVIDENCE=true` at zero API cost. `ECONOMIC_API_KEY` (a wrong variable name — the real one is `ECONOMIC_CALENDAR_API_KEY`) was also found and fixed in two places in `README_FILES/README.md`'s live-activation checklist.

Everything else in the data-channel surface held up: MT5 file-bridge protocol, candle/quote validation, weekend-gap handling, provider identity checks, and the auto-research cross-check against MT5 were all already correct. Full `npm run test:ts` (20 suites, including the 2 above) and `pytest tests/ai` (15 tests) pass; `tsc --noEmit` clean.

## v22 (this pass) — the project did not actually build; fixed, full suite re-verified

Full systematic pass rather than a targeted diff: compiled every `.py`
file (`py_compile`), ran a full strict `tsc --noEmit` (`strict`,
`noImplicitAny`, `noUncheckedIndexedAccess`), then actually executed
every test rather than just reading it — all 19 `test:ts` files via
`ts-node`, and all 15 Python tests by hand (this sandbox has no
`pytest` installed, so a small `tmp_path`/`monkeypatch`/`pytest.raises`
shim was written to run `test_promote_model.py`'s fixture-based tests
for real instead of skipping them). Then read every safety-critical
file line by line: `risk-engine.ts`, `order-manager.ts`,
`reconciliation.ts`, `decision-engine.ts`, `trading-loop.ts`, `env.ts`,
`mt5-file-bridge.ts`, `mt5-execution.adapter.ts`, `dashboard/server.ts`,
`model_loader.py`, and the MQL5 Expert Advisor. All of that held up —
fail-closed throughout, idempotency and reconciliation identity logic
consistent between the TS and MQL5 sides, no secrets committed, no
injection or path-traversal issues in the dashboard or database stores.

- **Bug found: `tsconfig.json` targeted `ES2021`, but the code uses
  `Array.prototype.at()`** (`features/advanced.ts`,
  `scripts/check-python-bridge.ts`, `scripts/preflight-live.ts`,
  `scripts/run-mt5.ts`) — a method that requires the ES2022 lib. This
  is not a style nit: `npm run build` fails outright on a clean
  checkout with `TS2550` on every call site, which means CI's build
  step (`.github/workflows/ci.yml` runs `npm run build` before the
  test steps) would have failed too. The project could not actually be
  built or deployed in its committed state, despite `tsc --noEmit`
  presumably having been run selectively rather than via the real
  `npm run build`/CI path in whichever environment produced v21. Fixed
  by bumping `target` to `ES2022` and adding an explicit
  `lib: ["ES2022", "DOM"]` — the `DOM` lib is required to keep `fetch`
  and `Response.json()` typed the permissive way the market-data
  provider code (`binance-market-data.provider.ts` et al.) expects;
  omitting it turns `json()` into `Promise<unknown>` under Node's own
  ambient `fetch` typings and breaks those call sites instead.
- Re-verified after the fix: `tsc --noEmit` clean (zero errors) on the
  full `src/` + `tests/` tree, `test:ts` 19/19 files passing, all 15
  Python tests passing. No other build, test, or logic defect found in
  this pass.

## v21 — candle-validator weekend-gap logic was broker-narrow; fixed, now with test coverage

Read through the files the two prior passes hadn't yet covered line by
line: `candle-validator.ts`, `evidence-aggregator.ts`/`evidence-service.ts`,
both execution adapters, `mt5-market-data.provider.ts`,
`account-store.ts`, `dashboard/server.ts`, `monitor.ts`. Two things that
looked initially suspicious turned out to be correct and already
covered by an explicit test assertion (`evidence.test.ts` line 84
specifically asserts a required-provider failure lands in
`invalidSources`, which is what the code does) — flagging that here so
a future pass doesn't waste time re-litigating it.

- **Bug found: the weekend-gap allowance in `candle-validator.ts` only
  recognized an exact Friday(5) -> Monday(1) day pair, and had zero test
  coverage.** MT5 brokers vary in how they stamp the first bar of the
  trading week — plenty stamp the Sunday 21:00-22:00 UTC market reopen
  (day=0), not Monday 00:00. For any broker using that (very common)
  convention, this would have flagged the ordinary weekly gap as a data
  integrity failure on every single Sunday/Monday session open — not a
  rare edge case but a recurring weekly one — forcing an incorrect
  `NO_TRADE` at the start of every trading week. Fail-closed, so not a
  money-losing bug, but a real functional defect that would have made
  the bot silently sit out the start of every week on affected brokers,
  indistinguishable from a real data outage in the logs. Broadened to
  accept any Friday/Saturday -> Saturday/Sunday/Monday pair (covers
  every observed broker stamping convention) while still correctly
  rejecting a same-week midweek gap. Added
  `tests/unit/weekend-gap.test.ts` (3 cases: Sunday reopen, Monday
  reopen, midweek gap still flagged) and wired it into `npm run test:ts`
  — this area had no coverage at all before.
- Re-verified: `tsc --noEmit` clean, `test:ts` now 20/20 files, `pytest
  tests/ai` 15/15, vertical slice and backtest reproduce identical
  results to v20 (this data path never exercised the changed branch on
  the synthetic dev data, as expected).

## v20 — deep dive on the live orchestration path; one defensive gap closed

Focused this pass on files the v19 pass hadn't yet read line-by-line: the
actual live trading loop (`run-mt5.ts`), `trading-loop.ts` (`runOnce`),
reconciliation identity-matching, `MongoOrderStore`, and the Python
production-model gates (`model_loader.py`, `promote_model.py`) plus their
TS-side shared parity check (`model-quality-gate.ts`) — confirmed the
thresholds in all three still match exactly. All held up structurally
sound and consistently fail-closed; reconciliation's direct-to-store
`SUBMITTED`/`FAILED` → `FILLED` recovery writes bypass `OrderManager`'s
state machine on purpose (documented, store-level optimistic-concurrency
guard, not a gap).

- **Closed a defensive gap: a null `atr14` could reach a live broker call
  before being rejected, instead of failing closed immediately.**
  `trading-loop.ts` computed the stop-loss reference passed to
  `getTradingSpec()` with `(features.atr14 as number) * 1.5` — a type
  cast, not a runtime check. `decision-engine.ts`'s feature-validity scan
  only rejects `atr14` when it is present *and* non-finite; a genuinely
  `null` value (e.g. insufficient warmup history) passes that check
  unflagged. `null * 1.5` evaluates to `0` in JS, so this would have
  silently computed a degenerate stop distance (equal to the entry price
  itself) and handed it to the broker/spec call. `risk-engine.ts`'s own
  explicit `atr14 === null` check still caught it one step later — no
  order could actually have been placed — but only after an unnecessary
  broker round-trip, and with the audit trail recording a misleading
  "broker trading specification unavailable" reason instead of the real
  one. Fixed by checking `atr14` explicitly before the call and failing
  closed immediately with the accurate reason, matching the audit-trail-
  honesty fix already applied to the adjacent crosscheck-rejection path.
  Re-verified: `tsc --noEmit` clean, `test:ts` 19/19, `pytest tests/ai`
  15/15, vertical slice and backtest smoke test produce byte-identical
  results to before the change (atr14 is never actually null on this
  synthetic data path — this was a hardening fix for an edge case, not a
  behavior change).

## v19 — independent re-verification; one real bug found and fixed

Did not trust the prior history on faith — re-ran everything fresh: `npx
tsc --noEmit` (clean), full `npm run test:ts` (19/19 files), `pytest
tests/ai` (15/15), `npm audit --audit-level=high` (0 vulnerabilities),
and a secrets/TODO/placeholder sweep of actual source (clean; the only
`.env.*.local` content is blank documented templates, already
gitignored). Also exercised the real pipeline end-to-end rather than
just reading about it: vertical slice, backtest, Python inference
bridge (correctly fail-safe-rejects with no production model),
`promote_model.py` (correctly refuses to promote the dev-synthetic
artifact), `preflight-live.ts` (correctly refuses without live env).

- **Bug found: the backtest engine smoke test could never take a single
  trade, silently.** `run-backtest.ts`'s placeholder predictor used
  `probability: 0.65, uncertainty: 0.35`. Both individually cleared
  `AI_MIN_PROBABILITY`/`AI_MAX_UNCERTAINTY`, but the decision engine's
  *combined* confidence (`probability * (1 - uncertainty)` = `0.4225`)
  was structurally below `DECISION_MIN_CONFIDENCE` (`0.55`) on every
  possible call — not an edge case, a mathematical impossibility given
  those constants. Across 2,950 synthetic bars this produced "Trades
  taken: 0, Signals rejected: 0" every run: the report looked like a
  clean pass, but the smoke test never exercised entry, fill,
  stop/target, or cost-application logic — the one thing it exists to
  verify. Fixed by raising the placeholder to `0.85/0.20` (combined
  `0.68`, comfortably above every gate while still an obvious
  placeholder, not a claim of real signal quality). Verified: now takes
  193 trades over the same data and exercises the full path. Full test
  suite re-verified green after the change.
- Everything else independently checked this pass (risk engine veto
  logic and stop/size math, order manager idempotency/state machine,
  the MT5 EA's auth/replay/broker-validation path, CI workflow,
  `package-lock.json`) held up with no defects found.

## v16 — closed both long-standing open items; found one broken script; env-file reorg exposed a real coupling bug

- **`DriftMonitor` was dead code.** Fully implemented, zero references
  anywhere. Closed end-to-end: models now save `feature_baseline_stats`
  (per-feature mean/std) at training time; `model_loader.py` and
  `promote_model.py` both fail closed without them on a production
  artifact; `run-mt5.ts`'s `predictionProvider` calls the extracted
  `checkFeatureDrift()` gate after every prediction and fails closed on
  drift, the same way it already failed closed on a missing prediction.
  9 new unit tests (`tests/unit/drift-monitor.test.ts`).
- **`AutomaticMarketDataOrchestrator` had no test coverage** because its
  constructor always built providers from live env vars with no injection
  seam. Gave it an optional injected-provider constructor argument
  (production behavior unchanged when omitted) and added 5 tests
  covering caching/interval behavior, the Binance crypto-symbol filter,
  failure surfacing, and quote-compatibility filtering.
- **Bug found: `check-python-bridge.ts` was silently broken.** Hardcoded
  a stale 14-column feature list from an earlier schema version (the
  model needs 34); running it threw `ValueError: feature row missing
  required columns`. Nobody had caught this because `npm run test:ts`
  never invokes this diagnostic script. Fixed by reading the feature
  schema from the model's own metadata sidecar instead of a second
  hand-maintained list.
- **Bug found (self-introduced, caught by re-running the suite after
  adding `.env.development.local`): `enabled` still silently re-checked
  the global env singleton even with providers injected.** The injection
  seam added above bypassed the env-gated provider-*construction* logic,
  but the `enabled` getter kept checking `env.autoResearchMarketData`
  regardless — so once a checked-in `.env.development.local` set
  `AUTO_RESEARCH_MARKET_DATA=false` (a reasonable "don't hit real APIs
  during local dev" default), the orchestrator's own unit tests started
  failing, because their correctness now depended on an ambient `.env`
  file the test itself never controlled. This is exactly the kind of
  coupling a real injection seam should eliminate. Fixed: the class now
  tracks whether it was constructed with injected providers and skips the
  env re-check entirely in that case, so test outcomes depend only on
  what the test itself passes in.
- Re-verified fresh: `tsc --noEmit` clean, `npm run test:ts` 17/17,
  `pytest tests/ai` 15/15 — including a real run with
  `.env.development.local` present on disk, not just a clean CI-style
  environment, specifically because that's what exposed the bug above.

## v15 — MT5 EA used local wall-clock time instead of UTC

`AITradingBot.mq5`'s request handler authenticated every bridge request
(`HISTORY`, `QUOTE`, `SYMBOL`, `ORDER`, `ACCOUNT`, `POSITIONS`) against
`TimeLocal()*1000` — no timezone conversion — while the Node-side bridge
always stamps requests with `Date.now()` (true UTC). Unless the MT5 host's
system clock happened to be set to UTC+0, every single request failed one
of the two freshness checks — this is the normal case for most hosting
setups, not an edge case, and it broke the entire live pipeline (data
collection and order execution alike) identically. Fixed: `TimeLocal()` →
`TimeGMT()`. **Not independently testable in this sandbox** (no MT5
terminal/compiler available) — needs verification on a real terminal,
ideally with its OS clock deliberately not set to UTC.

## v14 — economic-calendar evidence direction was inverted

`trading-economics-calendar.provider.ts` mapped `surprise > 0` to
`BULLISH` unconditionally, feeding directly into the decision engine's
evidence-conflict veto. Two real defects: (1) it ignored which of the
pair's two currencies the event belonged to — a stronger-than-expected
print on the *quote* currency should move the pair the opposite direction
from a base-currency print, but both were scored identically; (2) for
"lower is stronger" indicators (unemployment rate, jobless claims), a
higher-than-forecast actual is bad news and was scored backwards. Fixed
both; indicators with genuinely regime-dependent polarity (CPI/PPI) now
report NEUTRAL with reduced confidence instead of a guessed direction. 4
new tests (`tests/unit/trading-economics-calendar.test.ts`).

## v13 — checked-in model artifact was unloadable

`requirements.txt` pinned `scikit-learn>=1.5` (open-ended); the checked-in
dev artifact was pickled under 1.8.0, and a fresh install pulled 1.9.0,
whose changed internal Cython structures made `joblib.load` throw
`ModuleNotFoundError: No module named '_loss'`. This wasn't hypothetical —
`pytest tests/ai` failed 3/13 before the fix. Every prior audit claimed
the Python suite verified, but none of those environments had working
`pip install`, so it had never actually run since whatever environment
produced that artifact. Fixed: pinned `scikit-learn==1.9.0` exactly,
retrained the dev artifact under the pinned version, deleted the old
unloadable pair.

## v8 (merge) — reconciled two divergent uploads, independently re-verified

Two uploaded archives turned out not to be divergent branches — one was
the other plus the (then-unmerged) v7 pass. Took the superset as base,
then independently re-audited the highest-consequence paths rather than
trusting the prior notes: risk engine input validation and veto ordering,
order idempotency-key derivation, reconciliation's identity matching
(symbol + side + idempotency-comment + positive volume, so it can't
collide with manual/netting trades), execution adapter's refusal of
non-live-tagged or stop/take-profit-less orders, decision engine's
live-mode refusals (dev provider, no prediction provider, existing
managed position), and a secret-handling/injection sweep (no `eval`, no
shell-mode `exec`, no hardcoded credentials, no leftover `TODO`/`FIXME`).
No new defects found. This sandbox's network egress was blocked at the
time, so this pass was static review only — no fresh `npm`/`pytest` run.

## v7 — environment-variable inventory audit

Built the ground-truth env-var list directly from `src/config/env.ts`
(confirmed the sole place `process.env` is read on the TS side; the
Python side reads no env vars at all — config flows through CLI args and
JSON metadata) and diffed it against `.env.example`. Found:
`RECONCILIATION_FAILED_LOOKBACK_MS` was read in code but entirely
undocumented in the example file; `vendorDataProvider`'s fallback default
was `"twelvedata"` while both the example file and the documented
architecture policy said MT5 should be authoritative — code and policy
disagreed. Fixed both. Also documented that `MT5_COMMON_DIRECTORY`'s
doubled-backslash example value is passed through literally by `dotenv`
(not an escape sequence) — harmless on Windows but confusing to
hand-edit, so added a clarifying comment.

## v6 — production model quality gates had a silent coverage gap

`promote_model.py` (the intended sole path into `models/production/`)
enforces six quality gates before promoting a candidate. `run-mt5.ts` and
`preflight-live.ts` — the actual last line of defense before an order can
be placed with real money — only re-verified three of the six; the
absolute accuracy floor, absolute Brier ceiling, and better-than-random
balanced-accuracy checks were silently missing from both, despite a
comment already claiming parity with `run-mt5.ts`. Concretely, a model
that failed promotion's absolute accuracy floor could still have passed
the old live-startup check via the edge-over-baseline math alone. Fixed
by extracting one shared `assertProductionModelQualityGates()` function
with thresholds copied exactly from `promote_model.py`, called by both
sites so they can no longer drift apart. 8 new tests
(`tests/unit/model-quality-gate.test.ts`).

## v5 — closed remaining unreviewed surfaces, no new bugs

Audited `mt5/Include/` (empty placeholder, nothing to review) and checked
every claim in `docs/` against the actual source line-by-line (env var
names, npm script names, the MT5 identity-check claim, `decision-engine.ts`'s
confidence threshold). All held up. Flagged (not yet fixed) that
`implemented-upgrades.md` listed the drift detector alongside genuinely
wired-in features without the "implemented but unwired" caveat it needed
at the time.

## v4 — execution/evidence/monitoring pass

- **Paper-mode fills silently lost their fill data.** The paper adapter
  returned `success: true` with `filledPrice: null` despite claiming to
  simulate a real fill; a downstream exemption let that null price pass
  confirmation, but `recordExecution()`'s own separate guard on non-null
  price meant it silently never ran — every paper trade reached FILLED
  with no `brokerOrderId`/`filledPrice`/`filledVolume` ever recorded.
  Fixed by threading a real reference price through and removing the
  exemption so both adapters require a non-null price.
  `tests/unit/paper-fill.test.ts` added.
- **Evidence service swallowed failure diagnostics on the required-provider
  early-return path** — fixed to record them, same as the normal path.
- **Runtime health status reported "unhealthy" on ordinary HOLD
  decisions** (`risk.approved` is only ever true for BUY/SELL, so HOLD —
  likely the majority of real cycles — was never exempted). Fixed.
- **`preflight-live.ts` was missing two of the production-model gates**
  `run-mt5.ts` actually enforced — a model could pass preflight and then
  be rejected at actual live start. Fixed (later generalized into the
  shared gate function in v6).
- **`model_loader.py`'s production gate had the same gap, but worse** — it's
  the function *every* inference call passes through, and only re-verified
  provenance/row-count/finiteness, not the baseline-edge checks. Fixed.
- Renamed a misleadingly-named test file (`automatic-data.test.ts` →
  `cached-evidence-provider.test.ts`) that tested `CachedEvidenceProvider`
  despite its name — flagged rather than fixed that
  `AutomaticMarketDataOrchestrator` itself still had zero coverage.

## v3 — first pass: CI had never actually run, plus five real bugs

- **`.github/workflows/ci.yml`'s `npm ci` had no `package-lock.json` to
  work with and refused to run at all** — meaning every step after it
  (`tsc`, `npm run test:ts`, `npm run test:py`) had never executed in CI,
  which is almost certainly why the bugs below shipped in an otherwise
  carefully-reviewed codebase. Fixed by generating and committing the
  lockfile.
- **Backtest engine only charged commission on exit, not entry**, despite
  its own cost model documenting both — every backtest understated costs
  by one commission leg, making strategies look more profitable than the
  configured model allows.
- **Evidence conflict score misfired to maximum on neutral-only
  evidence.** Any calm-market period with fresh-but-non-directional
  evidence would silently block every trade via the `conflictScore >
  0.75` veto — directly contradicting the decision engine's own "neutral
  evidence must not zero out a valid model" comment a few lines away.
  Likely the highest-impact bug found in this pass.
- **`.sort()` on `fs.Dirent[]` with no comparator is a silent no-op**
  (stringifies to `"[object Dirent]"` for every entry) — used to select
  the "latest" production model in both `run-mt5.ts` and
  `preflight-live.ts`. Could silently activate a stale or wrong model
  version on a live-trading path. Fixed by sorting explicitly on
  `entry.name`.
- **The project didn't actually type-check** (`noUncheckedIndexedAccess`
  violations in the MT5 bridge and the calendar provider) — invisible
  because of the CI gap above. Fixed.
- A dead, overwritten ternary in `ai/validation/walk_forward.py` was
  functionally harmless (the real embargo protection is applied
  elsewhere, every fold) but actively misleading about what the code
  does. Removed, and added `tests/ai/test_walk_forward.py`, which hadn't
  existed before.

---

## Current state (as of v24)

Every item every prior pass carried forward as "still open, design
decision not a bug" is now either closed or is the intentional, permanent
state of the project:

- ~~`AutomaticMarketDataOrchestrator` lacks test coverage~~ — closed in v16.
- ~~`DriftMonitor` implemented but not wired in~~ — closed in v16.
- ~~`getPositions()` field-count mismatch / empty-response-on-zero-positions~~
  — closed in v24. See above; this was the highest-severity finding in the
  project's history (crashed startup unconditionally against a real MT5
  terminal), and it took 24 passes to catch because the wire format was
  never exercised end-to-end by any test until v24.
- **No real trading model exists yet.** This is not a gap to close — it's
  the intended state. `models/production/` stays empty until real MT5
  historical data replaces the dev-synthetic dataset and a candidate is
  walk-forward validated and explicitly promoted through
  `promote_model.py`. Every gate documented above exists specifically to
  keep it that way until a human earns the right to fill it.
- **The v15 MT5 EA `TimeGMT()` fix, and the v24 `HandlePositions()`
  sentinel-line fix, remain unverified on a real MT5 terminal** — this
  sandbox has no MT5 compiler. Both are logically verified (the v24 fix's
  wire format is covered by `testGetPositionsParsesRealEaWireFormat`
  against the exact bytes `HandlePositions()` emits) but not yet confirmed
  against a live MetaEditor compile and a running terminal. Do this before
  trusting either fix in a real live-trading session.

Every fresh full-suite run this history references
(`npx tsc --noEmit`, `npm run test:ts`, `pytest tests/ai`) was passing as
of v24: 21/21 TS test files, 15/15 Python tests, zero type errors.
