import { aggregateEvidence } from "./evidence-aggregator";
import { EvidenceProvider } from "./provider";
import { EvidenceObservation, EvidenceSnapshot } from "./types";

export async function collectEvidence(symbol: string, providers: EvidenceProvider[], now = Date.now()): Promise<EvidenceSnapshot> {
  // [FIX-EVIDENCE-PARALLEL-FETCH] Same class of latency bug as
  // AutomaticMarketDataOrchestrator.refresh(): each provider is an
  // independent HTTP call (its own timeoutMs, default 5s in
  // AuthorizedHttpEvidenceProvider) with no dependency on the others, yet
  // this loop fetched them strictly one after another. collectEvidence()
  // sits squarely on the entry-trigger hot path — trading-loop.ts awaits it
  // before even fetching the MT5 execution quote — on every single cycle.
  // Each provider is normally wrapped in its own CachedEvidenceProvider
  // with an independent refresh interval, but every one of those caches
  // starts cold together on process startup (and can realign periodically
  // afterwards), so a sequential fetch of N configured providers could add
  // up to N times a single provider's timeout of pure, avoidable latency to
  // every decision. Fetching concurrently bounds one collectEvidence() call
  // to roughly the single slowest provider instead of the sum of all of
  // them.
  const results = await Promise.all(providers.map(async (provider) => {
    try {
      return { observations: await provider.getObservations(symbol, now), failure: null as string | null };
    } catch (error) {
      const failure = `${provider.name}: ${error instanceof Error ? error.message : String(error)}`;
      // [FIX-EVIDENCE-PARTIAL-OUTAGE] A required provider's failure must
      // never discard observations already collected from other (healthy)
      // providers — it only contributes its own zero-confidence marker
      // observation, visible via quality.invalidSources/unavailableSources.
      const observations: EvidenceObservation[] = provider.required
        ? [{
            source: provider.name,
            kind: "NEWS",
            symbol,
            timeframe: null,
            observedAtUtc: now,
            validUntilUtc: now,
            direction: "UNKNOWN",
            strength: 0,
            confidence: 0,
            features: { providerFailure: true },
            references: [],
          }]
        : [];
      return { observations, failure };
    }
  }));

  const observations = results.flatMap((result) => result.observations);
  const failures = results.map((result) => result.failure).filter((failure): failure is string => failure !== null);

  const snapshot = aggregateEvidence(symbol, observations, now);
  if (failures.length > 0) snapshot.quality.unavailableSources.push(...failures);
  return snapshot;
}
