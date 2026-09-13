# Production Readiness Gate

The system is intentionally fail-closed. A successful build or backtest is not permission to trade live.

## Required gates
1. Real historical data from an authorized source; no synthetic data for production models.
2. Feature parity between training and live inference.
3. Chronological walk-forward validation with embargo and untouched out-of-sample data.
4. Realistic spread, commission, slippage and execution assumptions.
5. MT5 Strategy Tester verification where applicable.
6. Sustained MT5 demo operation with reconciliation and failure-injection tests.
7. News/economic/sentiment provider credentials and licensing verified.
8. Monitoring, alerts, audit trail and emergency stop verified.
9. Production model artifact provenance verified; synthetic/unknown training sources are rejected.
10. Explicit human activation of live mode.

## External intelligence
The project ships normalized provider interfaces. It does not fabricate news, economic events or sentiment when credentials are absent. Configure authorized endpoints in `.env.<environment>.local` and keep credentials out of git.

## External provider wiring audit (2026-09-07)

Implemented direct, documented API adapters:

1. **Twelve Data** — `https://api.twelvedata.com/time_series` and `/quote`; API key required. Used for independent forex/crypto research and historical OHLCV, never as execution truth.
2. **Binance public market data** — `https://data-api.binance.vision/api/v3/klines`, `/api/v3/ticker/bookTicker`, `/api/v3/ping`; public market-data endpoints. Used for crypto research/market data, not MT5 execution.
3. **Alpha Vantage News & Sentiment** — `https://www.alphavantage.co/query?function=NEWS_SENTIMENT...`; API key required. News/sentiment is normalized into evidence and cannot directly place an order.
4. **Trading Economics Calendar** — `https://api.tradingeconomics.com/calendar/country/{country}/{from}/{to}`; API key required. Calendar events are normalized and can participate in safety/context decisions.

The system does not scrape Forex Factory or Investing.com pages. If a future provider offers an authorized API/feed with appropriate licensing and historical point-in-time semantics, it can be plugged into the provider interfaces without changing the trading engine.

### Remaining hard production gates

- Real MT5 historical data must replace synthetic training data.
- Expanded ensemble must be trained and walk-forward validated on real data.
- Historical news/sentiment and point-in-time economic data must be aligned to decision timestamps before those features are used for model training; future/revised information is prohibited.
- TypeScript dependency installation/build must succeed in the target environment before deployment.
- Paper trading must run for a meaningful out-of-sample period and pass risk/execution/reconciliation tests before any live activation.
- Live order submission is now code-enabled behind explicit production activation gates. It still requires a real production model, real news/economic providers, MongoDB, MT5 bridge health, durable reconciliation, and the explicit live environment flags.
- Broker-authoritative position sizing now uses MT5 `OrderCalcProfit` for the exact entry/stop pair; the old price-distance-as-lots approximation is not used for live orders.
- Live reconciliation is identity-based (`magic number` + idempotency comment), not merely symbol/side/volume matching.
- The MT5 EA validates direction of SL/TP, broker volume constraints, margin, stop/freeze distances, synchronous execution, and broker retcodes before confirming an order.
- Production model loading requires real-data provenance and a meaningful untouched final OOS qualification report.


## Latest hardening audit (2026-09-07)

Additional controls now enforced:
- Live startup requires an explicit acknowledgement string in addition to the activation token.
- Live mode always requires external evidence; it cannot disable the evidence gate.
- MT5 PING verifies configured magic number, account login, and broker server identity.
- The EA rejects stale bridge requests so a command left on disk while MT5 was offline cannot execute hours later.
- A filesystem kill switch (`LIVE_KILL_SWITCH_FILE`) disables new entries while leaving existing broker-side protective orders untouched.
- Consecutive runtime failures trip a process-level safety circuit breaker instead of retrying indefinitely.
- Training/live OBV semantics are bounded and consistent; candlestick feature scoring is aligned between Python training and TypeScript inference.
- Live M1/M5 history requests now fetch enough bars to construct the configured higher-timeframe context.
- Reconciliation can recover a broker-filled position when the client timed out after submission.
- Order state is mutated locally only after the durable database transition succeeds.
- Production model startup additionally verifies symbol/timeframe identity, real-data provenance, OOS size, baseline edge, and Brier improvement.
