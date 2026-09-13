# Implemented Upgrades

This revision expands the original vertical slice without pretending external credentials exist.

- Expanded indicators: WMA, MACD, Stochastic, ROC, Bollinger Bands, historical volatility, VWAP and OBV.
- Candlestick pattern engine with contextual pattern scores; patterns are not standalone trade triggers.
- Market-structure engine with higher/lower structure, BOS and CHoCH features.
- Model feature-vector contract shared by the live TS path and Python model schema.
- Calibrated three-model ensemble with member disagreement and entropy-based uncertainty.
- Production model provenance guard: synthetic/unknown artifacts cannot load as production.
- Drift detector for monitoring; it never self-modifies a production model.
- Live evidence remains provider-driven and fail-closed; no fake news, calendar or sentiment is generated.
- Local runtime dashboard at `npm run dashboard` showing the latest decision/risk status.

## Still external by design

Real news, economic-calendar and sentiment credentials, vendor licenses, broker connectivity, MetaEditor compilation and MT5 broker-specific behavior must be supplied/verified by the deployment environment. The code provides the integration contracts and validation rather than fabricating those services.
