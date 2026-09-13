import { EvidenceObservation, EvidenceQuality, EvidenceSnapshot, EvidenceDirection } from "./types";
import { MarketRegime } from "../types";
import { env } from "../../config/env";

export function aggregateEvidence(symbol: string, observations: EvidenceObservation[], now = Date.now()): EvidenceSnapshot {
  const invalidSources: string[] = [];
  const staleSources: string[] = [];
  const fresh: EvidenceObservation[] = [];

  for (const observation of observations) {
    const valid = observation.symbol === symbol
      && Number.isFinite(observation.observedAtUtc)
      && Number.isFinite(observation.validUntilUtc)
      && observation.validUntilUtc > observation.observedAtUtc
      && observation.validUntilUtc >= observation.observedAtUtc
      && [observation.strength, observation.confidence].every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
    if (!valid) {
      invalidSources.push(observation.source);
      continue;
    }
    const ageMs = now - observation.observedAtUtc;
    if (observation.validUntilUtc < now || ageMs < 0 || ageMs > env.evidenceMaxAgeMs) {
      staleSources.push(observation.source);
      continue;
    }
    if (observation.confidence < env.evidenceMinConfidence) {
      staleSources.push(`${observation.source}:low-confidence`);
      continue;
    }
    fresh.push(observation);
  }

  const directional = fresh.filter((observation) => observation.direction === "BULLISH" || observation.direction === "BEARISH");
  const bullishWeight = directional.filter((observation) => observation.direction === "BULLISH").reduce((sum, observation) => sum + observation.strength * observation.confidence, 0);
  const bearishWeight = directional.filter((observation) => observation.direction === "BEARISH").reduce((sum, observation) => sum + observation.strength * observation.confidence, 0);
  const totalWeight = bullishWeight + bearishWeight;
  // No directional evidence at all (e.g. every fresh source reported
  // NEUTRAL, which real providers do routinely — a quiet economic
  // calendar or near-zero news sentiment) is an absence of signal, not
  // a conflict, and must not be scored as maximal conflict (1). Doing so
  // previously caused the decision engine's `conflictScore > 0.75` gate
  // to veto every trade whenever evidence was fresh but non-directional,
  // even though the decision engine's own neutral-evidence handling
  // further down was written specifically to allow this case through.
  const conflictScore = totalWeight > 0 ? Math.min(bullishWeight, bearishWeight) / Math.max(bullishWeight, bearishWeight) : 0;
  const confidence = directional.length === 0 ? 0 : Math.min(1, Math.abs(bullishWeight - bearishWeight) / Math.max(totalWeight, 1e-9));
  const quality: EvidenceQuality = {
    sourceCount: observations.length,
    freshSourceCount: fresh.length,
    staleSources,
    invalidSources,
    unavailableSources: [],
    conflictScore,
    confidence,
  };

  return { symbol, asOfUtc: now, observations: fresh, quality, regime: inferRegime(fresh) };
}

function inferRegime(observations: EvidenceObservation[]): MarketRegime {
  const regime = observations.find((observation) => observation.kind === "REGIME");
  const value = regime?.features.regime;
  if (typeof value === "string" && ["TRENDING_BULLISH", "TRENDING_BEARISH", "RANGING", "HIGH_VOLATILITY", "LOW_VOLATILITY", "TRANSITION", "ABNORMAL", "UNKNOWN"].includes(value)) {
    return value as MarketRegime;
  }
  return "UNKNOWN";
}

export function evidenceDirection(observations: EvidenceObservation[]): EvidenceDirection {
  const snapshot = aggregateEvidence(observations[0]?.symbol ?? "", observations);
  if (snapshot.quality.confidence < 0.2 || snapshot.quality.conflictScore > 0.75) return "UNKNOWN";
  const bullish = snapshot.observations.filter((item) => item.direction === "BULLISH").length;
  const bearish = snapshot.observations.filter((item) => item.direction === "BEARISH").length;
  return bullish > bearish ? "BULLISH" : bearish > bullish ? "BEARISH" : "NEUTRAL";
}
