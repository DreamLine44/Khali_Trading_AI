# MASTER BUILD PROMPT

## Build a Production-Disciplined AI Trading System for MetaTrader 5

You are an expert team of quantitative developers, machine-learning
engineers, financial data engineers, algorithmic trading engineers, MQL5
developers, backend engineers, DevOps engineers, cybersecurity engineers,
and software architects.

Your task is to design and progressively validate an AI-assisted
algorithmic trading system for MetaTrader 5 (MT5). "Real-time" means
bounded-latency processing of live events after the required data and
execution controls are proven; it does not imply low latency, uptime, or
profitability guarantees.

This is NOT a toy trading bot, indicator script, simple Expert Advisor,
demo project, or hard-coded BUY/SELL strategy.

Build a modular, testable, observable, fault-tolerant trading
platform capable of processing real market information, analyzing
multiple sources of evidence, generating probabilistic trading
decisions, enforcing strict risk controls, and executing trades through
MT5/MQL5.

---

## 1. PRIMARY OBJECTIVE

Build the most accurate, robust, adaptive, fault-tolerant, risk-aware,
and technically reliable trading system realistically achievable.

The system must:

- use real market data from reliable sources
- process historical and real-time data
- analyze multiple timeframes
- analyze price action
- detect candlestick patterns
- calculate technical indicators
- analyze market structure
- analyze volatility
- analyze volume where meaningful
- analyze liquidity/microstructure when reliable data is available
- consume financial news
- consume economic-calendar/event information
- perform financial-market sentiment analysis
- detect market regimes
- use machine learning/AI where it provides measurable value
- combine multiple independent sources of evidence
- estimate prediction confidence and uncertainty
- reject low-quality opportunities
- apply strict risk management
- execute through MT5/MQL5
- monitor live performance
- detect model/data degradation
- support controlled retraining
- maintain complete trade-decision auditability
- survive failures without turning them into uncontrolled trades or losses

The system should optimize for:

**HIGH-QUALITY DECISIONS + ROBUST DATA + STATISTICALLY VALIDATED
SIGNALS + STRICT RISK MANAGEMENT + LOW EXECUTION ERROR + FAULT
TOLERANCE + MODEL VALIDATION + CAPITAL PRESERVATION**

Do not optimize merely for the number of trades or historical win rate.

---

## 2. CRITICAL REQUIREMENT: ELIMINATE AVOIDABLE MISTAKES

Treat error prevention as a first-class architectural requirement.

The system must aggressively prevent:

- invalid market data
- stale market data
- duplicated data
- missing data
- corrupted data
- timestamp inconsistencies
- incorrect timezone handling
- look-ahead bias
- data leakage
- unrealistic backtesting
- duplicate orders
- accidental repeated execution
- incorrect position sizing
- invalid stop-loss/take-profit levels
- excessive exposure
- trading beyond configured limits
- trading with insufficient account margin
- trading when required information is unavailable
- trading after critical system failure
- assuming an order succeeded without confirmation
- model failures silently producing trades
- stale AI predictions being reused incorrectly
- uncontrolled model updates
- unvalidated new models entering production
- abnormal spread conditions
- abnormal liquidity conditions
- unexpected execution conditions
- inconsistent account state
- synchronization errors between the bot and MT5
- race conditions
- state corruption
- configuration errors
- numerical errors
- malformed external API responses
- unavailable external providers
- contradictory market information being blindly interpreted as certainty

Every critical component must fail safely.

---

## 3. NEVER CLAIM IMPOSSIBLE PERFECTION

Do NOT implement or claim:

- 100% prediction accuracy
- guaranteed profit
- guaranteed winning trades
- never losing
- perfect prediction of the future
- zero market uncertainty

However, do pursue the strongest realistic implementation possible.

The objective is:

Zero avoidable engineering mistakes wherever technically achievable.
Maximum realistic predictive performance.
Maximum protection against uncertain predictions.
Maximum capital preservation.

The system must distinguish between **engineering uncertainty** and
**market uncertainty**.

Engineering failures should be aggressively prevented.

Market uncertainty must be detected, quantified where possible, and
managed through confidence thresholds, uncertainty estimation,
filtering, diversification, position sizing, and risk controls.

---

## 4. COMPLETE SYSTEM ARCHITECTURE

Use a modular architecture similar to:

```
AI-Trading-Bot/
│
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── controllers/
│   │       ├── routes/
│   │       ├── middleware/
│   │       ├── services/
│   │       └── server.ts
│   │
│   └── dashboard/
│       └── src/
│           ├── components/
│           ├── pages/
│           ├── charts/
│           └── services/
│
├── core/
│   ├── market-data/
│   │   ├── providers/
│   │   ├── collectors/
│   │   ├── normalizers/
│   │   └── market-data.service.ts
│   │
│   ├── news/
│   │   ├── providers/
│   │   ├── collectors/
│   │   ├── normalizers/
│   │   └── news.service.ts
│   │
│   ├── sentiment/
│   │   ├── sources/
│   │   ├── processing/
│   │   ├── scoring/
│   │   └── sentiment.service.ts
│   │
│   ├── features/
│   │   ├── price/
│   │   ├── volume/
│   │   ├── volatility/
│   │   ├── technical/
│   │   ├── market-structure/
│   │   ├── macro/
│   │   ├── sentiment/
│   │   ├── regime/
│   │   └── feature-engine.ts
│   │
│   ├── decision/
│   │   ├── signal/
│   │   ├── strategy/
│   │   ├── regime/
│   │   └── decision-engine.ts
│   │
│   ├── risk/
│   │   ├── position-sizing/
│   │   ├── stop-loss/
│   │   ├── take-profit/
│   │   ├── exposure/
│   │   ├── drawdown/
│   │   └── risk-engine.ts
│   │
│   ├── portfolio/
│   │   ├── positions/
│   │   ├── orders/
│   │   ├── account/
│   │   └── portfolio.service.ts
│   │
│   └── orchestration/
│       ├── trading-loop.ts
│       ├── event-handler.ts
│       └── system-orchestrator.ts
│
├── ai/
│   ├── models/
│   │   ├── market/
│   │   ├── sentiment/
│   │   ├── regime/
│   │   └── ensemble/
│   │
│   ├── training/
│   │   ├── datasets/
│   │   ├── preprocessing/
│   │   ├── trainers/
│   │   └── train.py
│   │
│   ├── inference/
│   │   ├── prediction.py
│   │   └── inference.py
│   │
│   ├── validation/
│   │   ├── walk_forward.py
│   │   ├── cross_validation.py
│   │   └── metrics.py
│   │
│   ├── optimization/
│   │   └── hyperparameter.py
│   │
│   └── common/
│       ├── model_loader.py
│       └── config.py
│
├── backtesting/
│   ├── engine/
│   ├── data/
│   ├── simulation/
│   ├── costs/
│   ├── metrics/
│   └── reports/
│
├── execution/
│   ├── adapters/
│   │   ├── execution-adapter.ts
│   │   ├── paper/
│   │   └── mt5/
│   ├── orders/
│   │   ├── order-manager.ts
│   │   ├── order-validator.ts
│   │   └── order-state.ts
│   └── execution.service.ts
│
├── mt5/
│   ├── Experts/
│   │   └── AITradingBot/
│   ├── Include/
│   │   ├── Bridge/
│   │   ├── Trading/
│   │   └── Common/
│   └── Scripts/
│       ├── ExportMarketData.mq5
│       └── AccountInfo.mq5
│
├── database/
│   ├── audit-log.ts
│   ├── mongo-client.ts
│   ├── indexes.ts
│   └── repositories/
│
├── data/
│   ├── raw/
│   ├── processed/
│   └── features/
│
├── models/
│   ├── development/
│   ├── staging/
│   ├── production/
│   └── archived/
│
├── monitoring/
│   ├── logs/
│   ├── metrics/
│   ├── alerts/
│   └── health/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── ai/
│   ├── backtesting/
│   ├── risk/
│   ├── execution/
│   └── mt5/
│
├── scripts/
│   ├── setup.ts
│   ├── seed.ts
│   ├── train.py
│   ├── backtest.py
│   └── health-check.ts
│
├── docs/
│   ├── architecture/
│   ├── trading/
│   └── ai/
│
├── package.json
├── tsconfig.json
├── pyproject.toml
├── docker-compose.yml
├── .env.example
├── .gitignore
└── README.md
```

You may improve this architecture when technically justified, but do
not remove essential capabilities merely to make the project smaller.

### MongoDB persistence requirement

MongoDB is the required operational database. Do not introduce SQL
drivers, ORM migrations, relational schemas, or a generic
`DATABASE_URL`. Use the official MongoDB Node.js driver behind repository
interfaces so the trading core is not coupled to collection details.

At minimum, define collections for `trade_decisions`, `orders`,
`executions`, `positions`, `account_snapshots`, `market_events`,
`model_versions`, and `system_events`. Store immutable audit records with
stable IDs and UTC timestamps. Add unique indexes for decision/order
idempotency keys and query indexes for symbol, timeframe, status, and
time. Define retention, archival, encryption, backup, restore, and
availability policies explicitly. A MongoDB outage must fail closed for
new trades; it must not be hidden by an unbounded local fallback.

JSONL or in-memory persistence is permitted only in development and tests,
must be named as such, and must never be presented as production storage.

---

## 5. TECHNOLOGY REQUIREMENTS

Use the best language for each job.

**Python** — machine learning, quantitative research, feature
engineering where appropriate, model training, model validation,
statistical analysis, NLP, sentiment analysis, backtesting components
where appropriate. Potential libraries: NumPy, pandas, scikit-learn,
XGBoost, LightGBM, PyTorch, appropriate NLP libraries. Do not add
libraries simply because they are popular — every major dependency
must have a technical reason.

**TypeScript/Node.js** — APIs, orchestration, services, dashboards,
configuration, system integration, monitoring, event handling.

**MQL5** — the MT5 execution boundary. Do NOT pretend there is a
magical native Node.js-to-MT5 interface. Create a clean execution
adapter between the trading system and MT5/MQL5. The architecture must
allow the core trading engine to operate independently of the exact
MT5 communication mechanism.

---

## 6. REAL MARKET DATA

Never use fake market data in production.

Support reliable real-time and historical data. The system should
process, where available: tick data, OHLCV, bid/ask, spread, volume,
multiple timeframes, market depth/order-book information when
legitimately available, trading sessions, timestamps, instrument
specifications.

Create provider interfaces so providers can be replaced without
rewriting the trading engine.

Every incoming dataset must undergo validation. Validate: timestamps,
missing values, duplicates, impossible prices, negative/invalid
values, gaps, outliers, stale data, symbol mismatches, timeframe
consistency, timezone consistency.

If market data is unreliable: **NO NEW TRADE.**

### 6A. MARKET DATA PROVIDER STRATEGY

Use a two-tier data model, not a single provider:

- **Broker-authoritative data** — bid/ask, spread, symbol
  specifications, margin requirements, account state, open positions,
  order execution, and confirmation — must come from MT5 directly.
  This data defines what the account can actually do and must never be
  second-guessed from an external vendor.
- **Research/historical data** — deep historical OHLCV, additional
  symbols, alternate timeframes, or higher-quality tick history for
  backtesting and feature research — may come from a separate
  market-data vendor.

Do not hard-lock the project to a named vendor (e.g. Polygon, Twelve
Data). Build a `MarketDataProvider` interface and select the specific
vendor based on technical merit: data coverage, historical depth, tick
vs. bar granularity, latency, reliability/uptime, and cost. Document
the tradeoffs considered and the reasoning for whichever provider is
chosen. The interface must make swapping providers a configuration
change, not a rewrite.

---

## 7. MULTI-TIMEFRAME ANALYSIS

Support multiple timeframes. Do not treat every timeframe
independently. Build contextual relationships such as:

```
Higher timeframe -> Market regime / macro structure
      -> Medium timeframe -> Trend / structure
      -> Lower timeframe -> Entry conditions
```

The system must avoid accidentally using information that was
unavailable at the historical decision time.

---

## 8. PRICE ACTION

Implement objective, testable price-action features, where
statistically useful: higher highs/lows, lower highs/lows, swing
highs/lows, trend structure, break of structure, change of character
(where objectively defined), support/resistance, ranges, consolidation,
breakouts, false breakouts, rejection zones, volatility
expansion/contraction, liquidity areas where measurable.

Do not hard-code simplistic statements such as "Break of structure =
BUY." Every feature must be evaluated statistically.

---

## 9. CANDLESTICK PATTERNS

Support patterns including Doji, Hammer, Inverted Hammer, Shooting
Star, Hanging Man, Bullish/Bearish Engulfing, Morning/Evening Star,
Piercing Pattern, Dark Cloud Cover, Inside/Outside Bar, Marubozu,
Tweezer Top/Bottom.

BUT: a candlestick pattern must NEVER automatically trigger a trade.
The system must evaluate market regime, timeframe, trend, location,
volatility, structure, surrounding candles, support/resistance,
sentiment, news, and historical expectancy to determine whether a
pattern actually provides predictive value.

---

## 10. TECHNICAL INDICATORS

Implement and evaluate useful indicators.

- Trend: SMA, EMA, WMA, MACD, ADX
- Momentum: RSI, Stochastic, ROC
- Volatility: ATR, Bollinger Bands, historical volatility
- Volume: volume analysis, OBV where meaningful, VWAP where applicable

Do not blindly combine dozens of correlated indicators. Use feature
selection and statistical testing to determine which features add
information.

---

## 11. MARKET REGIME DETECTION

The system must detect changing market conditions: trending
bullish/bearish, ranging, high/low volatility, transition, abnormal
market conditions. Use statistical/ML approaches where appropriate.
Strategies should behave differently under different regimes.

If the system determines that current conditions do not resemble
validated historical conditions: reduce confidence or refuse to trade.

---

## 12. NEWS AND ECONOMIC EVENTS

Integrate reliable financial news and economic-event information.
Process: headline, publication time, source, asset relevance, currency
relevance, event importance, event category, expected impact, actual
result where available, forecast, historical context, news intensity.

Detect duplicate stories, stale stories, irrelevant stories,
conflicting reports, low-quality sources.

High-impact events must be incorporated into risk decisions.

---

## 13. SENTIMENT — REQUIRED BEFORE DEPENDENT STRATEGIES

Sentiment is a first-class component. Build and validate its provider
interface before enabling any strategy that requires sentiment. Until a
reliable source, freshness policy, and validation tests exist, those
strategies must return `NO_TRADE` rather than pretend sentiment is
available.

Analyze sentiment from relevant sources: financial news, market
headlines, economic announcements, other legitimate market-information
sources.

Generate structured sentiment information: sentiment_direction,
sentiment_strength, sentiment_confidence, sentiment_momentum,
news_intensity, source_reliability, asset_relevance,
currency_relevance, event_importance.

Handle conflicting sentiment, rapidly changing sentiment, low-confidence
sentiment, stale sentiment, duplicate information, source disagreement.

Sentiment must be evidence, NOT an automatic BUY/SELL trigger.

### 13A. NEWS / ECONOMIC CALENDAR / SENTIMENT — INTERFACES BEFORE CREDENTIALS

Real API credentials for news, economic-calendar, and sentiment
providers are not available yet. This must not block building the
architecture:

- Build the full provider interfaces now (mirroring the
  `MarketDataProvider` pattern), along with normalizers, collectors,
  and the sentiment-scoring pipeline described above.
- Use isolated development/test implementations of these interfaces
  during this phase.
- These test implementations must be clearly and unambiguously marked
  as non-real (naming, flags, and code comments) and must never be
  able to reach a production or live-trading code path. A dev provider
  silently passing as a real one is a critical defect, not a shortcut.
- When real credentials become available, wiring them in should
  require only implementing the interface — no changes to the decision
  engine, risk engine, or downstream pipeline.

---

## 14. AI/ML SYSTEM

Build a multi-model architecture where justified.

- **Market prediction**: probability of upward movement, probability
  of downward movement, probability of no meaningful movement,
  expected return, expected volatility, uncertainty.
- **Regime models**: current market regime, regime transition
  probability.
- **Sentiment models**: sentiment direction, strength, confidence.
- **Ensemble**: combine complementary models intelligently. Do not
  blindly average model outputs. Evaluate calibration, predictive
  power, stability, regime-specific performance, feature importance,
  model disagreement, uncertainty, degradation.

---

## 15. AI MUST BE ALLOWED TO SAY "I DON'T KNOW"

This is critical. The AI must not be forced to produce a BUY or SELL.
It must be capable of returning: BUY, SELL, HOLD, NO TRADE, EXIT,
INSUFFICIENT CONFIDENCE.

If evidence is contradictory or uncertainty is too high: NO TRADE. A
sophisticated trading system should know when NOT to trade.

---

## 16. DECISION ENGINE

The AI must NOT directly place orders. Use:

```
DATA -> VALIDATION -> FEATURE ENGINE -> AI MODELS -> PREDICTIONS
     -> CONFIDENCE / UNCERTAINTY -> DECISION ENGINE -> RISK ENGINE
     -> ORDER MANAGER -> MT5
```

The decision engine should evaluate AI predictions, price action,
candlestick context, technical indicators, market structure,
volatility, regime, sentiment, news, economic events, liquidity,
spread, expected reward/risk, current portfolio exposure.

The decision engine must be able to reject the AI prediction.

---

## 17. CONFIDENCE AND UNCERTAINTY

Do not treat raw model probability as truth. Implement confidence
thresholds, probability calibration, uncertainty estimation, model
disagreement detection, data-quality confidence, regime confidence,
sentiment confidence.

Example:

```
Prediction: BUY, Model probability: 0.84
But: Data quality: poor, Regime confidence: low,
     Model disagreement: high, Spread: abnormal, News risk: extreme
Final decision: NO TRADE
```

---

## 18. RISK ENGINE

The risk engine has veto power over every proposed trade. Evaluate
account balance, equity, free margin, current exposure, open
positions, correlated positions, maximum risk per trade, maximum
portfolio risk, daily loss, drawdown, consecutive losses, volatility,
spread, liquidity, stop distance, position size, reward/risk, market
conditions.

If risk requirements fail: NO TRADE. The AI cannot override the risk
engine.

---

## 19. POSITION SIZING

Position size must be calculated systematically, considering account
equity, risk percentage, stop-loss distance, instrument properties,
volatility, portfolio exposure, correlation, drawdown state.

Never allow the AI to arbitrarily choose dangerous position sizes. Add
hard upper limits.

---

## 20. STOP LOSS AND TAKE PROFIT

Stops and targets must be based on tested logic: ATR, volatility,
market structure, swing points, support/resistance, expected movement,
liquidity, reward/risk. Do not use arbitrary fixed values without
justification.

---

## 21. EXECUTION SAFETY

Before submitting an order, validate symbol, direction, volume, price,
stop loss, take profit, margin, spread, market status, trading
permissions, account status, duplicate-order state, existing exposure.

After submitting an order: never assume success. Require confirmation
from MT5. Synchronize bot state, MT5 state, and broker state. If
states disagree: STOP NEW TRADES AND RECONCILE.

---

## 22. DUPLICATE ORDER PROTECTION

Implement strong idempotency. The same signal must not accidentally
create multiple trades. Track signal ID, decision ID, order ID,
execution ID, position ID, timestamps, state transitions.

Order state must be explicit: PROPOSED, VALIDATING, APPROVED,
SUBMITTED, CONFIRMED, REJECTED, CANCELLED, FILLED, PARTIALLY_FILLED,
CLOSED, FAILED.

---

## 23. FAIL-SAFE BEHAVIOR

When critical components fail:

- Missing market data → No new trade.
- Stale data → No new trade.
- AI model unavailable → No new trade.
- Sentiment service unavailable → Follow configured policy; for
  strategies requiring sentiment, no trade.
- News feed unavailable during high-impact event → No trade.
- MT5 connection lost → No new trade.
- Broker confirmation unavailable → Do not assume execution.
- Abnormal spread → No trade.
- Extreme abnormal volatility → No trade unless explicitly
  validated/configured.
- Database unavailable → No new trade.
- State inconsistency → Stop new trades and reconcile.
- Unknown error → Safe state.

Default rule: when the system is uncertain about whether it is safe to
trade, it must not open a new position.

---

## 24. BACKTESTING

Build a realistic backtesting engine. It must prevent look-ahead bias,
data leakage, survivorship bias where applicable, unrealistic fills,
unrealistic spreads, unrealistic slippage, unrealistic commissions,
impossible execution.

Include spread, slippage, commission, latency assumptions, market
sessions, rejected orders where appropriate, position sizing, stops,
targets, partial fills where relevant.

---

## 25. WALK-FORWARD VALIDATION

Do not trust one backtest. Use:

```
Training -> Validation -> Out-of-sample test -> Walk-forward
     -> Stress testing -> Paper trading -> Limited live deployment
```

Never allow future information to influence historical decisions.

---

## 26. MODEL EVALUATION

Evaluate more than win rate: net return, profit factor, expectancy,
maximum drawdown, Sharpe ratio, Sortino ratio, recovery factor, win
rate, average win, average loss, consecutive losses, trade frequency,
exposure, turnover, performance by symbol/timeframe/regime/volatility/
sentiment condition.

Also measure calibration, prediction stability, model drift,
degradation, false positives, false negatives, uncertainty quality.

---

## 27. STRESS TESTING

Simulate sudden volatility, extreme spreads, slippage, missing/delayed
data, news shocks, flash-like movements, connection loss, MT5 failure,
broker rejection, repeated losses, prolonged drawdown, regime changes,
model degradation. The system must remain controlled.

---

## 28. ADAPTIVE LEARNING

The system should adapt, but NOT through uncontrolled self-modification:

```
Production Model -> Performance Monitoring -> Drift Detection
     -> Retraining -> Validation -> Out-of-Sample Testing
     -> Paper Trading -> Candidate Model -> Comparison
     -> Controlled Deployment
```

A new model must prove that it is better or safer before replacing the
production model. Always maintain a production model, candidate model,
previous stable model, and rollback mechanism. Never allow an AI model
to rewrite its own production logic without validation.

---

## 29. TRADE AUDIT TRAIL

For EVERY proposed and executed trade, store: timestamp, symbol,
timeframe, market data snapshot/reference, features, indicators, price
action, candlestick context, market structure, volatility, regime,
news, economic events, sentiment, AI predictions, confidence,
uncertainty, model versions, strategy decision, risk decision,
position size, stop loss, take profit, execution result, MT5 response,
final outcome.

The system must be able to answer "Why did you take this trade?" and
"Why did you reject this trade?"

---

## 30. CONTINUOUS PERFORMANCE ANALYSIS

After trades close, analyze prediction vs. actual outcome, expected
vs. realized movement, model confidence vs. actual accuracy, strategy
performance, regime performance, sentiment usefulness, feature
usefulness, execution quality, slippage, spread, risk effectiveness.
Identify recurring failure patterns. Don't just say "the trade lost" —
determine why.

---

## 31. NO BLIND COMPLEXITY

Do not add indicators, models, APIs, neural networks, strategies,
features, databases, or microservices just because they sound
advanced. Every component must have a measurable purpose. Prefer a
smaller, statistically validated system over a huge one full of
redundant signals.

---

## 32. OBSERVABILITY

Implement structured logging, system/model/data/MT5-connection/
execution health monitoring, latency monitoring, error monitoring,
risk monitoring, drawdown monitoring, alerts.

The dashboard should show at minimum: account state, balance, equity,
open positions, active orders, current market, signals, confidence,
sentiment, regime, risk state, system health, model health, recent
decisions, trade history, performance, drawdown.

---

## 33. SECURITY

Protect API keys, credentials, broker credentials, model files,
database, communication channels. Never hard-code secrets. Use secure
environment/configuration management. Validate all external input.

---

## 34. TESTING

Build comprehensive tests: unit tests for every critical function;
integration tests across Market Data → Feature Engine → AI → Decision
→ Risk → Execution; AI tests (prediction consistency, model loading/
versioning, feature schema, missing/malformed input, confidence
thresholds); backtesting tests (no look-ahead, no leakage, correct
fees/spread/position sizing/P&L); risk tests (attempt to violate every
risk rule — system must reject them); execution tests (duplicate
orders, rejected orders, partial fills, delayed confirmation, MT5
disconnection, state mismatch); failure-injection tests (intentionally
break data provider, database, AI service, MT5, network, news
provider, sentiment provider — verify the system enters a safe state).

---

## 35. PAPER TRADING FIRST

The default mode MUST be DEVELOPMENT, then BACKTESTING, then PAPER
TRADING, then — only after validation — LIVE TRADING. Live trading must
require explicit activation. Never default to real-money trading.

---

## 36. SYSTEM DECISION PIPELINE

```
REAL MARKET DATA + REAL NEWS + ECONOMIC DATA + SENTIMENT + PRICE ACTION
+ CANDLESTICK PATTERNS + TECHNICAL INDICATORS + MARKET STRUCTURE
+ VOLATILITY + LIQUIDITY + MULTI-TIMEFRAME CONTEXT + MARKET REGIME
        |
        v
DATA VALIDATION -> FEATURE ENGINE -> AI / ML MODELS
        |
        v
PREDICTION + CONFIDENCE + UNCERTAINTY -> DECISION ENGINE
        |
        v
BUY / SELL / HOLD / NO TRADE / EXIT
        |
        v
RISK ENGINE -> RISK APPROVED? --NO--> NO TRADE
        |
       YES
        v
ORDER VALIDATION -> DUPLICATE CHECK -> POSITION SIZING
        -> EXECUTION VALIDATION -> MT5 -> MQL5 -> BROKER
        -> EXECUTION CONFIRMATION -> ACCOUNT RECONCILIATION
        -> DATABASE + AUDIT -> PERFORMANCE -> DRIFT DETECTION
        -> CONTROLLED RETRAINING
```

---

## 37. DECISION PRIORITY

```
SAFETY -> DATA INTEGRITY -> RISK LIMITS -> EXECUTION INTEGRITY
       -> MARKET CONDITIONS -> MODEL PREDICTION -> TRADE OPPORTUNITY
```

A profitable signal must NEVER override a safety restriction.

---

## 38. "NO TRADE" IS A VALID SUCCESSFUL DECISION

Do not measure success only by winning trades. Track trades taken,
trades rejected, reason for rejection, hypothetical outcome of
rejected trades where measurable. Use this to improve filtering.

---

## 39. BUILD QUALITY REQUIREMENT

Write production-quality code. Do not leave fake implementations
pretending to be complete, use hard-coded BUY/SELL signals, use random
predictions, hide missing functionality, silently ignore errors,
swallow exceptions, bypass validation, skip tests, use future
information, or claim something works when it has not been
implemented.

If an external API requires credentials that are not available during
development: create the proper provider interface and clearly
separated development/test implementation, but do not pretend the test
implementation is real market data.

---

## 40. DEVELOPMENT PROCESS

Do NOT interpret this project as a day-by-day tutorial. The entire
architecture above is the blueprint. First understand the COMPLETE
SYSTEM. Then implement it progressively while preserving the
architecture.

At every stage: implement, test, validate, integrate, verify,
document, continue.

Do not destroy previously working components when implementing new
ones. Do not rewrite the project unnecessarily.

### 40A. IMPLEMENTATION ORDER AND RELEASE GATES

The implementation must follow explicit, reviewable release gates. The
coding agent may choose the next technically justified slice, but must
not imply that an unimplemented capability exists or enable live trading
without the required evidence and explicit human activation.

- Use this order unless a documented technical reason justifies a change:
  data validation and a working vertical slice; realistic backtesting;
  AI validation; news/economic-calendar/sentiment interfaces and tests;
  paper trading with real market data; then limited live execution.
- At every gate, record the scope, test evidence, known limitations,
  rollback plan, and explicit approval needed for the next environment.
- Proceed through that sequence autonomously, only surfacing a
  question when a decision genuinely cannot be made from the
  information in this document (e.g., a business/cost tradeoff, not an
  engineering one).
- State the chosen order and reasoning before starting, so the user
  can see and object to it, but treat that as informational, not a
  request for step-by-step sign-off.

---

## 41. DOCUMENTATION

Create documentation explaining architecture, data flow, AI pipeline,
feature engineering, trading logic, risk management, execution flow,
MT5/MQL5 integration, backtesting, model training, validation,
deployment, monitoring, emergency shutdown, recovery, configuration.
Another developer must be able to understand the system.

---

## 42. FINAL ENGINEERING STANDARD

Treat this as a serious algorithmic trading platform. The system
should behave like a disciplined professional trading system. It does
NOT: "See indicator → trade." It does: "Collect information → verify
information → understand market context → estimate probabilities →
evaluate uncertainty → compare multiple sources of evidence →
determine whether an opportunity has sufficient statistical edge →
apply risk controls → validate execution → execute → verify → record →
evaluate."

The system should be capable of saying: "The opportunity is not
sufficiently reliable. I will not trade." That is a core feature.

---

## 43. FINAL NON-NEGOTIABLE RULE

Before considering any component complete, ask: "What can go wrong
here?" Then implement protections against those failure modes.

For every subsystem, identify: expected failures, unexpected failures,
bad inputs, stale inputs, contradictory inputs, dependency failures,
state failures, numerical failures, security failures, recovery
behavior.

The goal is not merely to make the bot intelligent. The goal is to
make the entire system difficult to break, difficult to misuse,
difficult to fool with bad data, resistant to model errors, resistant
to execution errors, and incapable of taking uncontrolled risks when
uncertainty or failure occurs.

Build for maximum realistic intelligence + maximum engineering
reliability + maximum capital protection.

Do not sacrifice safety for more trades. Do not sacrifice statistical
validity for impressive backtest results. Do not sacrifice reliability
for complexity. Do not sacrifice capital preservation for prediction
confidence.

## Revision: Expanded intelligence and operational layer

The implementation must include, and keep synchronized between live TypeScript and Python training paths, WMA, MACD, Stochastic, ROC, Bollinger Bands, historical volatility, VWAP, OBV, objective candlestick patterns, market-structure HH/HL/LH/LL, BOS, CHoCH, support/resistance, regime classification, and contextual pattern/confluence scores. Candlestick patterns and indicators are evidence, never standalone entry triggers.

The AI layer should support a diverse calibrated ensemble, model disagreement, probability calibration, entropy/uncertainty, and a strict `NO_TRADE` state. Production model loading must reject synthetic or unknown training provenance.

The live decision engine must combine AI predictions with independently calculated market confluence and external evidence. AI alone must never authorize a trade. Risk remains an independent veto layer.

External news, economic-calendar and sentiment providers must use normalized, timestamped, freshness-validated contracts. No fabricated live evidence is permitted when credentials/providers are unavailable.

Add drift monitoring as an observation/alerting function only. No uncontrolled online self-retraining or self-modification is permitted. Candidate models require chronological walk-forward validation, out-of-sample validation and controlled promotion.

Provide a local operational dashboard for runtime health, mode, symbol/timeframe, latest decision, confidence, regime, risk status and decision reasons.
