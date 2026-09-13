import { EvidenceObservation } from "./types";
import { EvidenceProvider } from "./provider";

/**
 * Prevents the 15-second trading loop from hammering rate-limited evidence
 * APIs. A provider is refreshed only when its interval expires. A still-fresh
 * cached result is returned when a transient refresh fails.
 */
export class CachedEvidenceProvider implements EvidenceProvider {
  readonly name: string;
  readonly required: boolean;
  private readonly cache = new Map<string, { observations: EvidenceObservation[]; lastAttemptUtc: number; lastSuccessUtc: number }>();

  constructor(
    private readonly inner: EvidenceProvider,
    private readonly refreshIntervalMs: number,
  ) {
    if (refreshIntervalMs < 1000) throw new Error("CachedEvidenceProvider refresh interval must be >= 1000ms");
    this.name = inner.name;
    this.required = inner.required;
  }

  async getObservations(symbol: string, now = Date.now()): Promise<EvidenceObservation[]> {
    const state = this.cache.get(symbol);
    const due = !state || now - state.lastAttemptUtc >= this.refreshIntervalMs;
    if (!due) return state?.observations ?? [];

    const lastAttemptUtc = now;
    try {
      const observations = await this.inner.getObservations(symbol, now);
      this.cache.set(symbol, { observations, lastAttemptUtc, lastSuccessUtc: now });
      return observations;
    } catch (error) {
      // A cache may safely survive a provider outage only while the evidence
      // itself remains valid. The evidence aggregator performs the final
      // timestamp/freshness checks.
      if (state && state.observations.length > 0 && state.observations.some((item) => item.validUntilUtc > now)) {
        this.cache.set(symbol, { ...state, lastAttemptUtc });
        return state.observations;
      }
      this.cache.set(symbol, { observations: [], lastAttemptUtc, lastSuccessUtc: state?.lastSuccessUtc ?? 0 });
      throw error;
    }
  }

  get lastSuccessfulFetchUtc(): number {
    return Math.max(0, ...Array.from(this.cache.values()).map((state) => state.lastSuccessUtc));
  }
}
