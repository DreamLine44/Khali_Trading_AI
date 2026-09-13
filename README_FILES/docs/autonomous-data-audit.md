# Autonomous Data Acquisition Audit

## Audit result

The system is now wired so that the MT5/paper trading process acquires configured data sources automatically after startup. No manual fetch trigger is required during normal operation.

## Automatic paths

1. **MT5 authoritative market data**
   - `run-mt5.ts` creates `Mt5MarketDataProvider`.
   - The continuous trading loop calls `runOnce()` repeatedly using `MT5_POLL_INTERVAL_MS` (default 15 seconds).
   - `runOnce()` obtains validated MT5 candles automatically and obtains the live MT5 quote automatically when an entry decision requires a quote.
   - MT5 remains authoritative for execution price, spread, broker symbol specification, account state and execution confirmation.

2. **Direct supplementary market data**
   - `AutomaticMarketDataOrchestrator` is created automatically by `run-mt5.ts`.
   - When `AUTO_RESEARCH_MARKET_DATA=true`, configured Twelve Data and Binance credentials are discovered automatically.
   - A configured generic normalized vendor is also discovered when `VENDOR_DATA_API_KEY`, `VENDOR_DATA_PROVIDER`, and `VENDOR_DATA_ENDPOINT` are present.
   - Quotes and historical candles are automatically refreshed on separate schedules and cached.
   - Binance is only queried for identifiable crypto symbols. It is never used as a replacement for MT5 FX data.
   - Supplementary provider failures are explicit and auditable. They are never silently substituted into MT5 execution data.

3. **News and sentiment**
   - Configured Alpha Vantage, normalized news, Delta, or other configured evidence providers are invoked automatically through `collectEvidence()` from the trading loop.
   - `CachedEvidenceProvider` prevents the 15-second trading loop from hammering rate-limited external APIs.
   - Default news refresh is 60 seconds.

4. **Economic calendar**
   - Configured Trading Economics, Finnhub, or normalized economic evidence is invoked automatically through the same evidence pipeline — all configured sources run every cycle, not just one.
   - Default economic refresh is 5 minutes.

## Safety behavior

- A supplementary source is not allowed to become MT5 execution truth.
- Invalid or stale evidence is rejected by the evidence validator.
- A still-valid cached evidence result can survive a transient provider outage.
- One required evidence provider failing does not discard observations already collected from other providers, or skip providers still queued after it, in the same cycle — see "Third-pass" below.
- If no valid evidence remains for a required live evidence path, the decision layer prevents a new trade.
- `AUTO_RESEARCH_REQUIRED=true` can make configured supplementary market-data health a hard live-entry dependency. It defaults to false because these providers are supplementary, not execution-authoritative.
- The live kill switch, risk engine, reconciliation, broker checks and model gates remain independent controls.

## Important limitation

Automatic acquisition does not mean every provider is queried every 15 seconds. That would be operationally unsafe and would waste API quotas. Each provider has its own refresh interval and cached state.

Also, supplementary market data is currently treated as research/context data, not as a new ML feature. The production model feature schema remains based on the validated MT5 training/live contract. A supplementary source must be deliberately added to model training and out-of-sample validation before it can become an ML feature.

## Verification performed in this environment

- Python source compilation: passed.
- New cache unit test: passed.
- TypeScript compiler parsing was run; no source-level errors were reported for the changed files. Full type-check remains dependent on installing the project's Node type/dependency packages; `npm install` could not complete within the available environment timeout.
- Actual live provider requests and MetaEditor MQL5 compilation cannot be performed here without the user's credentials and MT5 terminal.


## Second-pass end-to-end automation audit

The live/paper MT5 loop is the autonomous runtime entry point. Every cycle automatically:
1. checks MT5 connectivity/account state;
2. reconciles managed positions;
3. refreshes MT5 candles;
4. refreshes configured supplementary market-data providers on their own schedules;
5. refreshes configured news/sentiment and economic-calendar providers through cached wrappers;
6. validates data;
7. computes the live feature set;
8. invokes the configured Python model automatically when AI is enabled;
9. applies deterministic confluence and external-evidence gates;
10. applies broker-aware risk controls;
11. submits and confirms orders through MT5;
12. audits the cycle.

### New second-pass protection

Compatible supplementary quotes are now automatically cross-checked against the MT5 quote before a new entry. A configured deviation threshold can veto the entry. MT5 remains authoritative for price, sizing and execution. This uses supplementary data as an independent data-quality control rather than pretending it is an ML feature.

### Important boundary: no unsafe automatic retraining

Training remains an explicit research operation. The live process must not silently retrain or replace a production model from newly collected data. Automatic retraining without point-in-time datasets, out-of-sample validation and an explicit promotion gate would create a model-governance and look-ahead risk. New external market/news data therefore cannot be silently injected into the existing production model: doing so would create a train/serve schema mismatch.

If external data is to become an ML feature, it must first be added to the historical point-in-time dataset builder, trained with the same feature schema, evaluated on untouched final OOS data, and then promoted through the existing production gate. Until that work is done, supplementary market data is used automatically for validation/context, while news/economic evidence is used automatically by the decision gate.

## Third-pass audit: source redundancy and partial-outage handling

Added a free Finnhub economic-calendar provider (`finnhub-economic-calendar.provider.ts`) as a real-data alternative to Trading Economics (whose non-sandbox key requires a paid plan). It runs alongside any other configured economic-calendar source rather than replacing it — `run-mt5.ts` registers every configured provider, and `evidence-aggregator.ts` merges whatever comes back fresh.

That surfaced a genuine bug in `collectEvidence()` (`evidence-service.ts`): a `required: true` provider's failure returned immediately, discarding every observation already collected from other providers earlier in the same cycle and skipping every provider still queued after it. With redundant sources configured per category — exactly what multi-provider setups like Alpha Vantage + a required generic news endpoint, or Trading Economics + Finnhub, are for — a single transient outage in one required source silently zeroed out evidence from every other healthy source too. Fixed so a required-provider failure is recorded (still visible in `quality.invalidSources` / `quality.unavailableSources`, unchanged) without erasing data other sources already proved was good. Covered by a new regression test in `tests/unit/evidence.test.ts` (`testRequiredProviderFailureDoesNotDiscardOtherSources`). Full `npm run test:ts` (20 suites) and `pytest tests/ai` (15 tests) pass after the change.
