# Market Data Adapter Contract

Vendor adapters must be authorized integrations. The core does not scrape
websites or bypass provider terms. A configured vendor endpoint must return:

```json
{
  "candles": [{
    "symbol": "EURUSD",
    "timeframe": "M15",
    "timestampUtc": 1788690000000,
    "open": 1.1,
    "high": 1.101,
    "low": 1.099,
    "close": 1.1005,
    "volume": 100,
    "isClosed": true
  }],
  "quote": {
    "symbol": "EURUSD",
    "timestampUtc": 1788690000000,
    "bid": 1.1004,
    "ask": 1.1006,
    "spread": 0.0002
  }
}
```

MT5 remains authoritative for live bid/ask, account state, and execution.
## Autonomous supplementary acquisition

The live/paper MT5 loop automatically runs `AutomaticMarketDataOrchestrator` on every trading cycle. When `AUTO_RESEARCH_MARKET_DATA=true` (the default), configured direct research providers are discovered from their API keys:

- `TWELVE_DATA_API_KEY` -> Twelve Data
- `BINANCE_API_KEY` -> Binance (only for symbols that are identifiable as crypto; it is never substituted for MT5 FX prices)

The orchestrator automatically refreshes provider quotes on `AUTO_RESEARCH_QUOTE_INTERVAL_MS` and historical candles on `AUTO_RESEARCH_HISTORY_INTERVAL_MS`, with in-memory caching so the 15-second MT5 trading loop does not hammer external APIs.

MT5 remains authoritative for the live trading symbol's bid/ask, spread, broker specification, account state and execution. Supplementary provider failures are recorded in the audit trail and do not silently become MT5 data. Set `AUTO_RESEARCH_REQUIRED=true` only when a configured supplementary source is intentionally a hard live-entry dependency.

No manual trigger is required after the process is started.

## Evidence polling and rate-limit protection

News and economic providers are also cached by the live/paper loop. `NEWS_REFRESH_INTERVAL_MS` defaults to 60 seconds and `ECONOMIC_REFRESH_INTERVAL_MS` defaults to 5 minutes. A transient provider failure can reuse still-valid cached observations; stale observations are rejected by the normal evidence freshness validator. This prevents the 15-second trading loop from turning into a rate-limit loop.
