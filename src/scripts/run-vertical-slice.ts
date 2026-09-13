import "../config/env";
import { DevMarketDataProvider } from "../core/market-data/providers/dev-market-data.provider";
import { PaperExecutionAdapter } from "../execution/adapters/paper/paper-execution.adapter";
import { OrderManager } from "../execution/orders/order-manager";
import { JsonlAuditLog } from "../database/audit-log";
import { runOnce } from "../core/orchestration/trading-loop";
import { AccountState } from "../core/risk/risk-engine";
import { ModelPrediction } from "../core/types";

async function main() {
  const dataProvider = new DevMarketDataProvider();
  const executionAdapter = new PaperExecutionAdapter();
  const orderManager = new OrderManager();
  const auditLog = new JsonlAuditLog();

  const account: AccountState = {
    balance: 10_000,
    equity: 10_000,
    freeMargin: 8_000,
    openPositionsCount: 0,
    dailyLossPct: 0,
    currentDrawdownPct: 0,
  };

  // Placeholder "model" prediction — replace with real output from
  // ai/inference/prediction.py once trained models exist. Left explicit
  // here (rather than hidden inside the decision engine) so it's obvious
  // this run has NO real AI in the loop yet.
  const placeholderPredictions: ModelPrediction[] = [
    { modelName: "placeholder", modelVersion: "0.0.0-dev", action: "BUY", probability: 0.7, uncertainty: 0.3 },
  ];

  const record = await runOnce(
    "EURUSD",
    "M15",
    account,
    { dataProvider, executionAdapter, orderManager, auditLog },
    placeholderPredictions
  );

  console.log(JSON.stringify(record, null, 2));
}

main().catch((err) => {
  console.error("vertical slice run failed:", err);
  throw err;
});
