# Data Provider Policy

## Authoritative source
MT5 is authoritative for the broker account: bid/ask, spread, symbol specifications, positions, orders, account state and execution results.

## Research / independent market data
- Twelve Data: `https://api.twelvedata.com/time_series` for OHLCV/time-series research and `/quote` for quotes.
- Binance public market data: `https://data-api.binance.vision/api/v3/klines`, `/api/v3/ticker/bookTicker`, `/api/v3/ping`. Public market-data endpoints do not require an API key.
- External vendor data must never override MT5 execution-sensitive values.

## News / sentiment
- Alpha Vantage `https://www.alphavantage.co/query?function=NEWS_SENTIMENT...` is used through `AlphaVantageNewsProvider` when `ALPHA_VANTAGE_API_KEY` is configured.
- Returned sentiment is evidence/context. It does not directly place an order.

## Economic calendar
- Trading Economics `https://api.tradingeconomics.com/calendar/country/{country}/{from}/{to}` is used through `TradingEconomicsCalendarProvider` when `ECONOMIC_CALENDAR_API_KEY` is configured.
- Point-in-time calendar data should be used for historical training/backtesting where the provider plan permits it; never substitute revised values for what was known at the historical decision time.

## Legitimacy and anti-scraping rule
The system does not scrape Forex Factory, Investing.com, Binance web pages, or other consumer pages. It uses documented/authorized APIs or the broker/terminal's official integration. A provider may be replaced without changing the trading engine because provider-specific logic is isolated behind interfaces.

## Failure policy
No provider response is fabricated. Missing/stale/corrupt data is marked unavailable. Execution-sensitive failures force no new trade. News/calendar failures follow the configured safety policy and are recorded in the audit trail.
