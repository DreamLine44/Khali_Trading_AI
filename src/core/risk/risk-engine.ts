import { Decision, FeatureSet, RiskCheckResult, SymbolTradingSpec } from "../types";

export interface AccountState {
  balance: number;
  equity: number;
  freeMargin: number;
  openPositionsCount: number;
  dailyLossPct: number; // negative = loss, e.g. -0.02 for -2%
  currentDrawdownPct: number; // positive magnitude, e.g. 0.05 for 5%
}

export interface RiskLimits {
  maxRiskPerTradePct: number; // fraction of equity, e.g. 0.01
  maxOpenPositions: number;
  maxDailyLossPct: number; // e.g. 0.03 -> stop trading past 3% daily loss
  maxDrawdownPct: number; // e.g. 0.15
  maxSpreadAsAtrFraction: number; // reject if spread too wide vs ATR
}

// [FIX-RISK-DEFAULT-PARITY] Previously 0.01 (1%), while run-mt5.ts's actual
// live/paper path builds its RiskLimits from RISK_MAX_PER_TRADE_PCT, whose
// own default is 0.005 (0.5%) — see env.ts. DEFAULT_RISK_LIMITS is what
// runBacktest() silently falls back to whenever a backtest doesn't pass its
// own riskLimits, and what evaluateRisk() falls back to for any caller that
// omits `limits` — so a backtest run without explicit risk config used to
// size every position at DOUBLE the risk-per-trade that live/paper trading
// would actually use by default, silently comparing a different risk
// profile than the one that will really be traded. Every other field here
// already matched its env.ts default (3 positions, 3% daily loss, 15%
// drawdown, 0.5x spread-to-ATR) — only this one had drifted.
export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxRiskPerTradePct: 0.005,
  maxOpenPositions: 3,
  maxDailyLossPct: 0.03,
  maxDrawdownPct: 0.15,
  maxSpreadAsAtrFraction: 0.5,
};

/**
 * The risk engine has veto power over every trade — the decision engine
 * (and any AI model behind it) cannot override this. Per spec section 18,
 * any failed check must result in NO_TRADE, never a "reduced size" fallback
 * unless that fallback is itself one of the explicit checks below.
 *
 * `entryPriceRef` must be the actual price the trade would fill near
 * (e.g. current close or quote), NOT a lagging indicator like EMA20 —
 * using a lagging value here can put the stop/target on the wrong side
 * of the real entry price in a trending market.
 */
export function evaluateRisk(
  decision: Decision,
  features: FeatureSet,
  account: AccountState,
  spread: number,
  entryPriceRef: number,
  limits: RiskLimits = DEFAULT_RISK_LIMITS,
  tradingSpec?: SymbolTradingSpec
): RiskCheckResult {
  const reasons: string[] = [];

  if (decision.action !== "BUY" && decision.action !== "SELL") {
    return { approved: false, reasons: ["decision is not an entry action"], maxPositionSize: null, stopLossPrice: null, takeProfitPrice: null };
  }

  if (!Number.isFinite(account.balance) || !Number.isFinite(account.equity) || account.equity <= 0) {
    reasons.push("account balance/equity is invalid");
  }
  if (!Number.isFinite(account.freeMargin) || account.freeMargin <= 0) {
    reasons.push("free margin is invalid or unavailable");
  }
  if (!Number.isFinite(account.openPositionsCount) || account.openPositionsCount < 0) {
    reasons.push("open position count is invalid");
  }
  if (!Number.isFinite(account.dailyLossPct) || !Number.isFinite(account.currentDrawdownPct)) {
    reasons.push("account loss/drawdown metrics are invalid");
  }
  if (!Number.isFinite(spread) || spread < 0) {
    reasons.push(`invalid spread (${spread})`);
  }
  if (!Number.isFinite(limits.maxRiskPerTradePct) || limits.maxRiskPerTradePct <= 0 || limits.maxRiskPerTradePct > 1) {
    reasons.push("invalid max risk per trade limit");
  }
  if (!Number.isFinite(limits.maxOpenPositions) || limits.maxOpenPositions < 0) {
    reasons.push("invalid maximum open positions limit");
  }
  if (!Number.isFinite(limits.maxDailyLossPct) || limits.maxDailyLossPct < 0 || !Number.isFinite(limits.maxDrawdownPct) || limits.maxDrawdownPct < 0) {
    reasons.push("invalid loss or drawdown limit");
  }
  if (!Number.isFinite(limits.maxSpreadAsAtrFraction) || limits.maxSpreadAsAtrFraction < 0) {
    reasons.push("invalid spread-to-ATR limit");
  }

  if (!Number.isFinite(entryPriceRef) || entryPriceRef <= 0) {
    reasons.push(`invalid entry price reference (${entryPriceRef})`);
  }
  if (account.currentDrawdownPct >= limits.maxDrawdownPct) {
    reasons.push(`drawdown ${account.currentDrawdownPct} >= max ${limits.maxDrawdownPct}`);
  }
  if (account.dailyLossPct <= -limits.maxDailyLossPct) {
    reasons.push(`daily loss ${account.dailyLossPct} breached limit ${-limits.maxDailyLossPct}`);
  }
  if (account.openPositionsCount >= limits.maxOpenPositions) {
    reasons.push(`open positions ${account.openPositionsCount} >= max ${limits.maxOpenPositions}`);
  }
  if (account.freeMargin <= 0) {
    reasons.push("insufficient free margin");
  }
  if (features.atr14 === null || !Number.isFinite(features.atr14) || features.atr14 <= 0) {
    reasons.push("ATR unavailable — cannot size stop distance safely");
  }
  if (features.atr14 !== null && spread > features.atr14 * limits.maxSpreadAsAtrFraction) {
    reasons.push(`spread ${spread} too wide relative to ATR ${features.atr14}`);
  }

  if (reasons.length > 0) {
    return { approved: false, reasons, maxPositionSize: null, stopLossPrice: null, takeProfitPrice: null };
  }

  const atrVal = features.atr14 as number;
  const stopDistance = atrVal * 1.5;
  const riskAmount = account.equity * limits.maxRiskPerTradePct;
  const stopLossPrice = decision.action === "BUY" ? entryPriceRef - stopDistance : entryPriceRef + stopDistance;
  const takeProfitPrice = decision.action === "BUY" ? entryPriceRef + stopDistance * 2 : entryPriceRef - stopDistance * 2;
  if ((decision.action === "BUY" && !(stopLossPrice < entryPriceRef && takeProfitPrice > entryPriceRef))
      || (decision.action === "SELL" && !(stopLossPrice > entryPriceRef && takeProfitPrice < entryPriceRef))) {
    return { approved: false, reasons: ["calculated stop/target is on the wrong side of entry"], maxPositionSize: null, stopLossPrice: null, takeProfitPrice: null };
  }

  let maxPositionSize: number;
  if (tradingSpec) {
    if (!Number.isFinite(tradingSpec.lossPerLotAtStop) || tradingSpec.lossPerLotAtStop <= 0) {
      return { approved: false, reasons: ["broker-authoritative loss-per-lot calculation is unavailable"], maxPositionSize: null, stopLossPrice: null, takeProfitPrice: null };
    }
    maxPositionSize = riskAmount / tradingSpec.lossPerLotAtStop;
    maxPositionSize = Math.floor(maxPositionSize / tradingSpec.volumeStep) * tradingSpec.volumeStep;
    maxPositionSize = Number(maxPositionSize.toFixed(8));
    if (maxPositionSize < tradingSpec.volumeMin) {
      return { approved: false, reasons: ["risk budget is below broker minimum volume"], maxPositionSize: null, stopLossPrice: null, takeProfitPrice: null };
    }
    if (maxPositionSize > tradingSpec.volumeMax) maxPositionSize = tradingSpec.volumeMax;
    const minStopDistance = tradingSpec.stopsLevelPoints * tradingSpec.point;
    if (Math.abs(entryPriceRef - stopLossPrice) < minStopDistance || Math.abs(takeProfitPrice - entryPriceRef) < minStopDistance) {
      return { approved: false, reasons: ["calculated stop/target is inside broker minimum stop distance"], maxPositionSize: null, stopLossPrice: null, takeProfitPrice: null };
    }
  } else {
    // Backtesting/paper fallback only. Live orchestration requires broker-authoritative sizing.
    maxPositionSize = riskAmount / stopDistance;
  }

  if (![maxPositionSize, stopLossPrice, takeProfitPrice].every(Number.isFinite) || maxPositionSize <= 0 || stopLossPrice <= 0 || takeProfitPrice <= 0) {
    return { approved: false, reasons: ["calculated order parameters are invalid"], maxPositionSize: null, stopLossPrice: null, takeProfitPrice: null };
  }

  return {
    approved: true,
    reasons: ["all risk checks passed"],
    maxPositionSize,
    stopLossPrice,
    takeProfitPrice,
  };
}
