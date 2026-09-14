# Multi-Account Deployment

Run one `run:mt5` process per MT5 account. Each process is a tenant worker and
must have its own `TRADING_INSTANCE_ID`, MT5 terminal/Common Files directory,
magic number, dashboard port, and environment secrets.

## Isolation rules

- Keep the existing synthetic worker on `.env.development.local` with no
  `TRADING_INSTANCE_ID`; this preserves its existing Mongo collections and
  runtime files.
- Give every additional worker a unique `TRADING_INSTANCE_ID`, such as
  `live-account-2` or `synthetic-account-3`.
- Never point two workers at the same MT5 Common Files directory. Run separate
  MT5 terminal instances and attach the EA to the intended account/chart.
- Use a different `MT5_MAGIC_NUMBER` for every worker.
- Use a different `DASHBOARD_PORT` for every worker, or run only one dashboard
  for the worker being inspected.
- Use separate bridge secrets and Mongo credentials where practical. Never
  reuse the live bridge secret for synthetic or another account.

Named tenants receive separate Mongo collections for orders, account
snapshots, and trade decisions. Their runtime status and kill-switch files are
also tenant-specific. The legacy synthetic worker remains on its existing
collections and paths for backward compatibility.

## Synthetic worker

Keep the current development configuration unchanged:

```dotenv
NODE_ENV=development
TRADING_MODE=synthetic
SYNTHETIC_TRADING_ENABLED=true
SYNTHETIC_ACTIVATION_CONFIRMATION=I_UNDERSTAND_SYNTHETIC_ORDERS
MT5_MAGIC_NUMBER=26090601
DASHBOARD_PORT=8787
```

## Separate live worker

Create a production environment outside the development file. Do not copy
synthetic credentials or use the same MT5 terminal directory:

```dotenv
NODE_ENV=production
TRADING_INSTANCE_ID=live-account-2
TRADING_MODE=live
LIVE_TRADING_ENABLED=true
LIVE_ACTIVATION_TOKEN=<unique-live-token-at-least-32-characters>
LIVE_ACTIVATION_CONFIRMATION=I_UNDERSTAND_LIVE_TRADING
LIVE_REQUIRE_EVIDENCE=true

AI_ENABLED=true
MODEL_STAGE=production
MT5_ACCOUNT_ID=<live-account-2-login>
MT5_SERVER=<live-account-2-server>
MT5_SYMBOL=EURUSDm
MT5_TIMEFRAME=M5
MT5_MAGIC_NUMBER=26090602
MT5_COMMON_DIRECTORY=<live-account-2-terminal-common-files>
MT5_BRIDGE_SECRET=<unique-live-bridge-secret>
MONGODB_URI=<production-mongodb-uri>
MONGODB_DATABASE=ai_trading_bot
DASHBOARD_PORT=8788

ALPHA_VANTAGE_API_KEY=<authorized-key>
FINNHUB_API_KEY=<authorized-key>
```

Before starting it, place a real-data production model matching `EURUSDm/M5`
in `models/production/` and run:

```powershell
$env:NODE_ENV = "production"
npm run preflight:live
npm run run:mt5
```

Do not set live variables in `.env.development.local`. The live preflight must
pass before the live worker is started.