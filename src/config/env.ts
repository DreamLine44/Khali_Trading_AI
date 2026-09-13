import * as fs from "fs";
import * as path from "path";
import { config as loadDotenv, parse as parseDotenv } from "dotenv";

const root = process.env.APP_ROOT ?? process.cwd();
const environment = (process.env.NODE_ENV ?? "development").trim().toLowerCase();
const allowedEnvironments = new Set(["development", "test", "production"]);
if (!allowedEnvironments.has(environment)) {
  throw new Error(`NODE_ENV must be development, test, or production; received ${environment}`);
}

// [FIX-ENV-SILENT-OVERRIDE] `loadDotenv({ override: false })` below is
// intentional: a real shell/system environment variable should be able to
// take precedence over a .env file (useful in CI/deployment). But until this
// fix, that precedence was silent — if TRADING_MODE=dev was already set in
// the OS environment, a .env file that clearly says TRADING_MODE=paper would
// be ignored with zero indication why, producing a confusing downstream
// error (e.g. run-mt5.ts's "requires TRADING_MODE=paper or live") that looks
// like a bad .env file when the file was actually fine. Snapshot the real
// environment before touching any .env file, then warn loudly, naming the
// exact variable and both values, whenever a file's value is being shadowed
// this way — for every .env file we load, not just one.
const realEnvSnapshot: Readonly<Record<string, string | undefined>> = { ...process.env };

function loadEnvFileWarningOnShadowedOverrides(filePath: string): void {
  const parsed = parseDotenv(fs.readFileSync(filePath));
  for (const [key, fileValue] of Object.entries(parsed)) {
    const realValue = realEnvSnapshot[key];
    if (realValue !== undefined && realValue !== fileValue) {
      // eslint-disable-next-line no-console
      console.warn(
        `[env] ${key}=${realValue} is already set in the real shell/system environment and is ` +
          `silently overriding ${key}=${fileValue} from ${path.basename(filePath)}. If that's not ` +
          `what you intended, unset ${key} in your shell/system environment (it takes precedence ` +
          `over every .env file, by design) rather than editing the file further.`
      );
    }
  }
  loadDotenv({ path: filePath, override: false });
}

const environmentFile = path.join(root, `.env.${environment}.local`);
if (fs.existsSync(environmentFile)) loadEnvFileWarningOnShadowedOverrides(environmentFile);
const baseFile = path.join(root, ".env");
if (fs.existsSync(baseFile)) loadEnvFileWarningOnShadowedOverrides(baseFile);

function stringValue(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}
function requiredString(name: string): string {
  const value = stringValue(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function integerValue(name: string, fallback: number, min?: number, max?: number): number {
  const raw = stringValue(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
    throw new Error(`${name} must be an integer${min !== undefined ? ` >= ${min}` : ""}${max !== undefined ? ` and <= ${max}` : ""}`);
  }
  return value;
}
function numberValue(name: string, fallback: number, min?: number, max?: number): number {
  const value = Number(stringValue(name, String(fallback)));
  if (!Number.isFinite(value) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
    throw new Error(`${name} must be a finite number${min !== undefined ? ` >= ${min}` : ""}${max !== undefined ? ` and <= ${max}` : ""}`);
  }
  return value;
}
function booleanValue(name: string, fallback: boolean): boolean {
  const raw = stringValue(name, String(fallback)).toLowerCase();
  if (raw !== "true" && raw !== "false") throw new Error(`${name} must be true or false`);
  return raw === "true";
}

const tradingMode = stringValue("TRADING_MODE", "dev").toLowerCase();
if (!["dev", "backtest", "paper", "live"].includes(tradingMode)) {
  throw new Error("TRADING_MODE must be dev, backtest, paper, or live");
}

const aiEnabled = booleanValue("AI_ENABLED", false);
const aiModeRaw = stringValue("AI_MODE", "ensemble").toLowerCase();
if (!["single", "ensemble", "hybrid"].includes(aiModeRaw)) throw new Error("AI_MODE must be single, ensemble, or hybrid");

// [FIX-DEAD-DUPLICATE-CONFIG] AI_MIN_PROBABILITY/AI_MAX_UNCERTAINTY are the
// only thresholds decision-engine.ts actually reads. MODEL_MIN_PROBABILITY/
// MODEL_MAX_UNCERTAINTY are legacy env var names kept only as fallback
// defaults when the AI_* ones are unset — not independent settings. This
// used to also export standalone modelMaxUncertainty/modelMinProbability
// fields that re-parsed the same two legacy vars and were never read
// anywhere in the codebase: setting MODEL_MAX_UNCERTAINTY while
// AI_MAX_UNCERTAINTY was already set looked like it tightened a second,
// separate gate, but did nothing at all — the dead field silently absorbed
// it. Removed the dead export; the fallback behavior below is unchanged.
const aiMinProbability = numberValue("AI_MIN_PROBABILITY", Number(stringValue("MODEL_MIN_PROBABILITY", "0.60")), 0, 1);
const aiMaxUncertainty = numberValue("AI_MAX_UNCERTAINTY", Number(stringValue("MODEL_MAX_UNCERTAINTY", "0.45")), 0, 1);
const evidenceMaxAgeMs = integerValue("EVIDENCE_MAX_AGE_MS", 900000, 0);
const decisionMinRegimeConfidence = numberValue("DECISION_MIN_REGIME_CONFIDENCE", 0.30, 0, 1);
const decisionMinConfidence = numberValue("DECISION_MIN_CONFIDENCE", 0.55, 0, 1);
const evidenceMinConfidence = numberValue("EVIDENCE_MIN_CONFIDENCE", 0.20, 0, 1);
const driftZThreshold = numberValue("DRIFT_Z_THRESHOLD", 3, 0);
const mt5BridgeTimeoutMs = integerValue("MT5_BRIDGE_TIMEOUT_MS", 10000, 100);
const mt5PollIntervalMs = integerValue("MT5_POLL_INTERVAL_MS", 15000, 5000);
// [FIX-PYTHON-BRIDGE-TIMEOUT] getPythonModelPrediction() spawns a fresh
// subprocess per cycle with no timeout of its own — a hung/deadlocked
// Python process (stuck model load, an inference script that itself makes
// a network call, etc.) would otherwise leave the `await` in
// predictionProvider() unresolved forever, freezing the entire trading
// loop (no more MT5 polling, no reconciliation, no new entries) until a
// human notices and restarts the process. Model artifacts are loaded in a
// fresh subprocess for each prediction; a cold start can legitimately take
// several seconds on Windows, so leave room for deserialization while still
// bounding a genuinely hung inference process.
const pythonPredictionTimeoutMs = integerValue("PYTHON_PREDICTION_TIMEOUT_MS", 30000, 500);
const dashboardPort = integerValue("DASHBOARD_PORT", 8787, 1, 65535);
const monitorPollIntervalMs = integerValue("MONITOR_POLL_INTERVAL_MS", 30000, 1000);
const monitorNoTradeStreakAlert = integerValue("MONITOR_NO_TRADE_STREAK_ALERT", 20, 1);
const monitorErrorStreakAlert = integerValue("MONITOR_ERROR_STREAK_ALERT", 3, 1);
// Default is 5x the MT5 poll interval: long enough that one slow cycle
// doesn't false-alarm, short enough that a genuinely stuck/crashed
// process (which stops updating the status file entirely) is caught
// well before a human would otherwise notice.
const monitorStatusStaleMs = integerValue("MONITOR_STATUS_STALE_MS", mt5PollIntervalMs * 5, 1000);
const riskMaxPerTradePct = numberValue("RISK_MAX_PER_TRADE_PCT", 0.005, 0.0001, 0.05);
const riskMaxOpenPositions = integerValue("RISK_MAX_OPEN_POSITIONS", 3, 0, 100);
const riskMaxDailyLossPct = numberValue("RISK_MAX_DAILY_LOSS_PCT", 0.03, 0, 1);
const riskMaxDrawdownPct = numberValue("RISK_MAX_DRAWDOWN_PCT", 0.15, 0, 1);
const riskMaxSpreadAtrFraction = numberValue("RISK_MAX_SPREAD_ATR_FRACTION", 0.5, 0, 10);
const quoteMaxAgeMs = integerValue("QUOTE_MAX_AGE_MS", 15000, 1000);
const autoResearchMarketData = booleanValue("AUTO_RESEARCH_MARKET_DATA", true);
const autoResearchQuoteIntervalMs = integerValue("AUTO_RESEARCH_QUOTE_INTERVAL_MS", 60000, 5000);
const autoResearchHistoryIntervalMs = integerValue("AUTO_RESEARCH_HISTORY_INTERVAL_MS", 300000, 30000);
const autoResearchHistoryBars = integerValue("AUTO_RESEARCH_HISTORY_BARS", 250, 20, 5000);
const autoResearchTimeoutMs = integerValue("AUTO_RESEARCH_TIMEOUT_MS", 10000, 500, 60000);
const autoResearchRequired = booleanValue("AUTO_RESEARCH_REQUIRED", false);
const autoResearchCrosscheck = booleanValue("AUTO_RESEARCH_CROSSCHECK", true);
const autoResearchMaxQuoteDeviationPct = numberValue("AUTO_RESEARCH_MAX_QUOTE_DEVIATION_PCT", 0.005, 0.0001, 0.25);
const newsRefreshIntervalMs = integerValue("NEWS_REFRESH_INTERVAL_MS", 60000, 5000);
const economicRefreshIntervalMs = integerValue("ECONOMIC_REFRESH_INTERVAL_MS", 300000, 30000);
const liveTradingEnabled = booleanValue("LIVE_TRADING_ENABLED", false);
const liveActivationToken = stringValue("LIVE_ACTIVATION_TOKEN");
const liveRequireEvidence = booleanValue("LIVE_REQUIRE_EVIDENCE", true);
const liveActivationConfirmation = stringValue("LIVE_ACTIVATION_CONFIRMATION");
const liveKillSwitchFile = stringValue("LIVE_KILL_SWITCH_FILE", path.join(root, "LIVE_KILL_SWITCH"));
const mt5MaxRequestAgeMs = integerValue("MT5_MAX_REQUEST_AGE_MS", 30_000, 1000, 300_000);
// A client-side submitOrder() timeout marks the durable order FAILED
// synchronously, even though the broker can still fill it moments later.
// Reconciliation looks back this far for FAILED live orders to recover any
// that turn out to have a matching broker position, instead of leaving the
// resulting position permanently unmanaged. See reconciliation.ts.
const reconciliationFailedLookbackMs = integerValue("RECONCILIATION_FAILED_LOOKBACK_MS", 86_400_000, 0);
if (tradingMode === "live" && environment !== "production") {
  throw new Error("TRADING_MODE=live requires NODE_ENV=production");
}
if (tradingMode === "live" && !liveTradingEnabled) {
  throw new Error("TRADING_MODE=live requires LIVE_TRADING_ENABLED=true");
}
if (tradingMode === "live" && liveActivationToken.length < 32) {
  throw new Error("TRADING_MODE=live requires LIVE_ACTIVATION_TOKEN of at least 32 characters");
}
if (tradingMode === "live" && liveActivationConfirmation !== "I_UNDERSTAND_LIVE_TRADING") {
  throw new Error("TRADING_MODE=live requires LIVE_ACTIVATION_CONFIRMATION=I_UNDERSTAND_LIVE_TRADING");
}
if (tradingMode === "live" && liveRequireEvidence !== true) {
  throw new Error("TRADING_MODE=live requires LIVE_REQUIRE_EVIDENCE=true");
}
const pythonCommand = stringValue("PYTHON_COMMAND") || (process.platform === "win32" ? "py" : "python3");
const modelStage = stringValue("MODEL_STAGE", "production").toLowerCase();
if (!["development", "staging", "production"].includes(modelStage)) throw new Error("MODEL_STAGE must be development, staging, or production");

export const env = {
  nodeEnv: environment,
  appRoot: root,
  tradingMode,
  mongodbUri: stringValue("MONGODB_URI"),
  mongodbDatabase: stringValue("MONGODB_DATABASE", "ai_trading_bot"),
  mt5AccountId: stringValue("MT5_ACCOUNT_ID"),
  mt5Server: stringValue("MT5_SERVER"),
  mt5CommonDirectory: stringValue("MT5_COMMON_DIRECTORY"),
  mt5BridgeSecret: stringValue("MT5_BRIDGE_SECRET"),
  mt5BridgeTimeoutMs,
  pythonPredictionTimeoutMs,
  mt5Symbol: stringValue("MT5_SYMBOL", "EURUSD"),
  mt5Timeframe: stringValue("MT5_TIMEFRAME", "M15"),
  mt5PollIntervalMs,
  mt5MagicNumber: integerValue("MT5_MAGIC_NUMBER", 26090601, 1),
  vendorDataApiKey: stringValue("VENDOR_DATA_API_KEY"),
  vendorDataProvider: stringValue("VENDOR_DATA_PROVIDER", "mt5").toLowerCase(),
  vendorDataEndpoint: stringValue("VENDOR_DATA_ENDPOINT"),
  twelveDataApiKey: stringValue("TWELVE_DATA_API_KEY"),
  deltaEvidenceEndpoint: stringValue("DELTA_EVIDENCE_ENDPOINT"),
  deltaApiKey: stringValue("DELTA_API_KEY"),
  binanceEvidenceEndpoint: stringValue("BINANCE_EVIDENCE_ENDPOINT"),
  binanceApiKey: stringValue("BINANCE_API_KEY"),
  binanceEvidenceApiKey: stringValue("BINANCE_API_KEY"),
  newsEvidenceEndpoint: stringValue("NEWS_EVIDENCE_ENDPOINT"),
  newsApiKey: stringValue("NEWS_API_KEY"),
  economicEvidenceEndpoint: stringValue("ECONOMIC_EVIDENCE_ENDPOINT"),
  economicApiKey: stringValue("ECONOMIC_CALENDAR_API_KEY"),
  alphaVantageApiKey: stringValue("ALPHA_VANTAGE_API_KEY"),
  finnhubApiKey: stringValue("FINNHUB_API_KEY"),
  pythonCommand,
  modelStage: modelStage as "development" | "staging" | "production",
  aiEnabled,
  aiMode: aiModeRaw as "single" | "ensemble" | "hybrid",
  aiMinProbability,
  aiMaxUncertainty,
  evidenceMaxAgeMs,
  evidenceMinConfidence,
  decisionMinRegimeConfidence,
  decisionMinConfidence,
  driftZThreshold,
  dashboardPort,
  monitorPollIntervalMs,
  monitorNoTradeStreakAlert,
  monitorErrorStreakAlert,
  monitorStatusStaleMs,
  riskMaxPerTradePct,
  riskMaxOpenPositions,
  riskMaxDailyLossPct,
  riskMaxDrawdownPct,
  riskMaxSpreadAtrFraction,
  quoteMaxAgeMs,
  autoResearchMarketData,
  autoResearchQuoteIntervalMs,
  autoResearchHistoryIntervalMs,
  autoResearchHistoryBars,
  autoResearchTimeoutMs,
  autoResearchRequired,
  autoResearchCrosscheck,
  autoResearchMaxQuoteDeviationPct,
  newsRefreshIntervalMs,
  economicRefreshIntervalMs,
  liveTradingEnabled,
  liveActivationToken,
  liveRequireEvidence,
  liveActivationConfirmation,
  liveKillSwitchFile,
  mt5MaxRequestAgeMs,
  reconciliationFailedLookbackMs,
};

export function requireEnv(name: keyof typeof env): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
