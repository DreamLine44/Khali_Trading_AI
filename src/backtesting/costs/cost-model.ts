export interface CostModelConfig {
  /** Fixed spread in price units, applied on entry (buy pays ask, sell pays bid). */
  spread: number;
  /** Slippage as a fraction of ATR at entry time (0.1 = 10% of ATR). */
  slippageAtrFraction: number;
  /** Commission per unit volume, charged on both entry and exit. */
  commissionPerUnit: number;
}

export const DEFAULT_COST_MODEL: CostModelConfig = {
  spread: 0.0002,
  slippageAtrFraction: 0.1,
  commissionPerUnit: 0.00002,
};

export function validateCostModel(cfg: CostModelConfig): void {
  if (!Number.isFinite(cfg.spread) || cfg.spread < 0) throw new Error("cost model spread must be finite and non-negative");
  if (!Number.isFinite(cfg.slippageAtrFraction) || cfg.slippageAtrFraction < 0) throw new Error("cost model slippage must be finite and non-negative");
  if (!Number.isFinite(cfg.commissionPerUnit) || cfg.commissionPerUnit < 0) throw new Error("cost model commission must be finite and non-negative");
}

/**
 * Applies realistic execution cost to a theoretical fill price.
 * Per spec section 24, a backtest that fills at the exact signal price
 * with zero cost is unrealistic and must not be trusted — every fill
 * in the backtest engine goes through this.
 */
export function applyEntryCost(
  side: "BUY" | "SELL",
  theoreticalPrice: number,
  atr: number,
  cfg: CostModelConfig = DEFAULT_COST_MODEL
): number {
  const halfSpread = cfg.spread / 2;
  const slippage = atr * cfg.slippageAtrFraction;
  // Buys fill worse (higher), sells fill worse (lower) — cost always
  // works against the trader, never in their favor.
  return side === "BUY" ? theoreticalPrice + halfSpread + slippage : theoreticalPrice - halfSpread - slippage;
}

export function applyExitCost(
  side: "BUY" | "SELL",
  theoreticalPrice: number,
  atr: number,
  cfg: CostModelConfig = DEFAULT_COST_MODEL
): number {
  const halfSpread = cfg.spread / 2;
  const slippage = atr * cfg.slippageAtrFraction;
  // Exiting a BUY means selling (pay the spread again on the way out).
  return side === "BUY" ? theoreticalPrice - halfSpread - slippage : theoreticalPrice + halfSpread + slippage;
}

export function commissionCost(volume: number, cfg: CostModelConfig = DEFAULT_COST_MODEL): number {
  return volume * cfg.commissionPerUnit;
}
