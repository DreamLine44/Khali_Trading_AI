import { Decision, FeatureSet, ModelPrediction, TradeAction } from "../types";
import { evidenceDirection } from "../evidence/evidence-aggregator";
import { env } from "../../config/env";

/**
 * Conservative decision gate. Signal generation is supplied by the caller:
 * ML, deterministic analysis, or both in HYBRID mode. This layer does not
 * know how a model was produced and never gives any predictor execution
 * authority. It validates predictions, requires agreement when multiple
 * predictors are supplied, applies market/evidence confluence, and leaves
 * final capital protection to the independent risk engine.
 */
const MIN_REGIME_CONFIDENCE = env.decisionMinRegimeConfidence;
const MIN_DECISION_CONFIDENCE = env.decisionMinConfidence;

export function makeDecision(features: FeatureSet, predictions: ModelPrediction[]): Decision {
  const reasons: string[] = [];
  let action: TradeAction = "NO_TRADE";
  let confidence = 0;

  if (!features.dataQuality.ok) {
    reasons.push(`data quality failed: ${features.dataQuality.issues.join("; ")}`);
    return finalize("NO_TRADE", 0, reasons, features, predictions);
  }

  const invalidFeature = [
    features.asOfUtc,
    features.regimeConfidence,
    features.sma20,
    features.ema20,
    features.rsi14,
    features.atr14,
    features.swingHigh,
    features.swingLow,
    features.adx14,
    features.swingHighDist,
    features.swingLowDist,
    features.bosBull,
    features.bosBear,
    features.rangePct,
    features.htfTrend,
  ].some((value) => value !== null && !Number.isFinite(value));
  if (!Number.isFinite(features.asOfUtc) || invalidFeature) {
    reasons.push("feature set contains non-finite values");
    return finalize("NO_TRADE", 0, reasons, features, predictions);
  }

  if (features.regimeConfidence < MIN_REGIME_CONFIDENCE) {
    reasons.push(`regime confidence too low (${features.regimeConfidence.toFixed(2)})`);
    return finalize("NO_TRADE", features.regimeConfidence, reasons, features, predictions);
  }

  if (features.evidence) {
    const evidence = features.evidence;
    if (evidence.quality.invalidSources.length > 0 || evidence.quality.freshSourceCount === 0) {
      reasons.push("required external evidence is invalid or unavailable");
      return finalize("NO_TRADE", 0, reasons, features, predictions);
    }
    if (evidence.quality.unavailableSources.length > 0) {
      reasons.push(`optional evidence unavailable: ${evidence.quality.unavailableSources.join("; ")}`);
    }
    if (evidence.quality.conflictScore > 0.75) {
      reasons.push(`external evidence conflict too high (${evidence.quality.conflictScore.toFixed(2)})`);
      return finalize("NO_TRADE", 0, reasons, features, predictions);
    }
  }

  if (predictions.length === 0) {
    reasons.push("no model predictions available");
    return finalize("INSUFFICIENT_CONFIDENCE", 0, reasons, features, predictions);
  }

  const invalidPrediction = predictions.find((prediction) => (
    prediction.modelName.trim().length === 0
    || prediction.modelVersion.trim().length === 0
    || !Number.isFinite(prediction.probability)
    || prediction.probability < 0
    || prediction.probability > 1
    || !Number.isFinite(prediction.uncertainty)
    || prediction.uncertainty < 0
    || prediction.uncertainty > 1
  ));
  if (invalidPrediction) {
    reasons.push(`invalid model prediction from ${invalidPrediction.modelName || "unknown model"}`);
    return finalize("NO_TRADE", 0, reasons, features, predictions);
  }

  // Naive ensemble: require agreement, not just an average (spec 14: "do
  // not blindly average model outputs"). Real ensemble logic (calibration,
  // per-regime weighting, disagreement detection) belongs in ai/models/ensemble.
  const actions = new Set(predictions.map((p) => p.action));
  if (actions.size > 1) {
    reasons.push(`model disagreement: ${[...actions].join(", ")}`);
    return finalize("NO_TRADE", 0, reasons, features, predictions);
  }

  const firstPrediction = predictions[0];
  if (firstPrediction === undefined) {
    reasons.push("no model predictions available");
    return finalize("INSUFFICIENT_CONFIDENCE", 0, reasons, features, predictions);
  }
  const agreedAction = firstPrediction.action;
  const avgProb = predictions.reduce((a, p) => a + p.probability, 0) / predictions.length;
  const maxUncertainty = Math.max(...predictions.map((p) => p.uncertainty));
  if (avgProb < env.aiMinProbability) {
    reasons.push(`model probability ${avgProb.toFixed(2)} below configured minimum ${env.aiMinProbability.toFixed(2)}`);
    return finalize("INSUFFICIENT_CONFIDENCE", avgProb, reasons, features, predictions);
  }
  if (maxUncertainty > env.aiMaxUncertainty) {
    reasons.push(`model uncertainty ${maxUncertainty.toFixed(2)} above configured maximum ${env.aiMaxUncertainty.toFixed(2)}`);
    return finalize("INSUFFICIENT_CONFIDENCE", avgProb * (1 - maxUncertainty), reasons, features, predictions);
  }
  // Regime confidence is already enforced as a hard gate above (line 32);
  // it must not ALSO be multiplied in here, or a low-but-passing regime
  // confidence (e.g. 0.4, as the current placeholder detector always
  // returns) makes MIN_DECISION_CONFIDENCE structurally unreachable no
  // matter how good the model predictions are.
  confidence = avgProb * (1 - maxUncertainty);

  if (confidence < MIN_DECISION_CONFIDENCE) {
    reasons.push(`combined confidence ${confidence.toFixed(2)} below threshold ${MIN_DECISION_CONFIDENCE}`);
    return finalize("INSUFFICIENT_CONFIDENCE", confidence, reasons, features, predictions);
  }

  action = agreedAction;

  // Independent market-analysis confluence gate. AI is advisory: the
  // model must agree with objectively computed structure/price-action and
  // momentum evidence. Candlestick patterns are contextual evidence, never
  // standalone triggers.
  if (action === "BUY" || action === "SELL") {
    const bullishStructure = features.structureTrend === "BULLISH" || features.bosBull === 1 || features.chochBull === 1;
    const bearishStructure = features.structureTrend === "BEARISH" || features.bosBear === 1 || features.chochBear === 1;
    const bullishMomentum = (features.macdHistogram ?? 0) > 0 || (features.roc12 ?? 0) > 0;
    const bearishMomentum = (features.macdHistogram ?? 0) < 0 || (features.roc12 ?? 0) < 0;
    const bullishPattern = features.candlestickPatterns.some(p => ["HAMMER", "BULLISH_ENGULFING", "MORNING_STAR", "PIERCING", "MARUBOZU_BULL", "TWEEZER_BOTTOM"].includes(p));
    const bearishPattern = features.candlestickPatterns.some(p => ["SHOOTING_STAR", "HANGING_MAN", "BEARISH_ENGULFING", "EVENING_STAR", "DARK_CLOUD_COVER", "MARUBOZU_BEAR", "TWEEZER_TOP"].includes(p));
    const supporting = action === "BUY" ? Number(bullishStructure) + Number(bullishMomentum) + Number(bullishPattern) : Number(bearishStructure) + Number(bearishMomentum) + Number(bearishPattern);
    const opposing = action === "BUY" ? Number(bearishStructure) + Number(bearishMomentum) + Number(bearishPattern) : Number(bullishStructure) + Number(bullishMomentum) + Number(bullishPattern);
    if (opposing >= 2 && supporting < opposing) {
      reasons.push(`AI ${action} conflicts with independent market confluence (${supporting} supporting vs ${opposing} opposing factors)`);
      return finalize("NO_TRADE", 0, reasons, features, predictions);
    }
    if (features.regime === "ABNORMAL" || features.regime === "TRANSITION" || features.regime === "UNKNOWN") {
      reasons.push(`market regime ${features.regime} is not sufficiently validated for a new entry`);
      return finalize("NO_TRADE", 0, reasons, features, predictions);
    }
  }

  if (features.evidence) {
    const direction = evidenceDirection(features.evidence.observations);
    const modelDirection = action === "BUY" ? "BULLISH" : action === "SELL" ? "BEARISH" : "NEUTRAL";
    if (direction !== "UNKNOWN" && direction !== "NEUTRAL" && direction !== modelDirection) {
      reasons.push(`model direction ${modelDirection} conflicts with external evidence ${direction}`);
      return finalize("NO_TRADE", 0, reasons, features, predictions);
    }
    // Neutral-only evidence (e.g. an economic calendar with no current
    // directional surprise) must not zero out a valid model. Directional
    // evidence is confidence-adjusted; neutral evidence remains a context
    // and risk input.
    const evidenceConfidence = features.evidence.quality.confidence > 0
      ? features.evidence.quality.confidence
      : 1;
    confidence *= evidenceConfidence;
    if (confidence < MIN_DECISION_CONFIDENCE) {
      reasons.push(`combined model and evidence confidence ${confidence.toFixed(2)} below threshold ${MIN_DECISION_CONFIDENCE}`);
      return finalize("INSUFFICIENT_CONFIDENCE", confidence, reasons, features, predictions);
    }
  }
  reasons.push(`models agreed on ${agreedAction} with combined confidence ${confidence.toFixed(2)} (regime confidence ${features.regimeConfidence.toFixed(2)})`);
  return finalize(action, confidence, reasons, features, predictions);
}

function finalize(
  action: TradeAction,
  confidence: number,
  reasons: string[],
  features: FeatureSet,
  predictions: ModelPrediction[]
): Decision {
  return {
    id: `dec_${features.symbol}_${features.timeframe}_${features.asOfUtc}`,
    symbol: features.symbol,
    timeframe: features.timeframe,
    createdAtUtc: Date.now(),
    action,
    confidence,
    reasons,
    predictions,
    featureSetRef: features,
  };
}
