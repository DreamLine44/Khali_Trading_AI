import { MarketRegime, Timeframe, TradeAction } from "../types";

export type EvidenceKind = "MARKET_STRUCTURE" | "PRICE_ACTION" | "TECHNICAL" | "ORDER_FLOW" | "NEWS" | "ECONOMIC_EVENT" | "SENTIMENT" | "REGIME";
export type EvidenceDirection = "BULLISH" | "BEARISH" | "NEUTRAL" | "UNKNOWN";

export interface EvidenceObservation {
  source: string;
  kind: EvidenceKind;
  symbol: string;
  timeframe: Timeframe | null;
  observedAtUtc: number;
  validUntilUtc: number;
  direction: EvidenceDirection;
  strength: number;
  confidence: number;
  features: Record<string, number | string | boolean | null>;
  references: string[];
}

export interface EvidenceQuality {
  sourceCount: number;
  freshSourceCount: number;
  staleSources: string[];
  invalidSources: string[];
  unavailableSources: string[];
  conflictScore: number;
  confidence: number;
}

export interface EvidenceSnapshot {
  symbol: string;
  asOfUtc: number;
  observations: EvidenceObservation[];
  quality: EvidenceQuality;
  regime: MarketRegime;
}

export interface EvidenceDecisionInput {
  action: TradeAction;
  confidence: number;
  uncertainty: number;
  reasons: string[];
}
