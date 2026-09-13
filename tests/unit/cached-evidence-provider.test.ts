import assert from "node:assert/strict";
import { CachedEvidenceProvider } from "../../src/core/evidence/cached-evidence-provider";
import { EvidenceProvider } from "../../src/core/evidence/provider";
import { EvidenceObservation } from "../../src/core/evidence/types";

class FakeProvider implements EvidenceProvider {
  readonly name = "fake";
  readonly required = true;
  calls = 0;
  async getObservations(_symbol: string, now = Date.now()): Promise<EvidenceObservation[]> {
    this.calls += 1;
    return [{
      source: this.name,
      kind: "NEWS",
      symbol: "EURUSD",
      timeframe: null,
      observedAtUtc: now,
      validUntilUtc: now + 60_000,
      direction: "NEUTRAL",
      strength: 0,
      confidence: 1,
      features: {},
      references: [],
    }];
  }
}

async function main() {
  const inner = new FakeProvider();
  const cached = new CachedEvidenceProvider(inner, 60_000);
  await cached.getObservations("EURUSD", 1_000);
  await cached.getObservations("EURUSD", 10_000);
  assert.equal(inner.calls, 1, "provider must be cached within refresh interval");
  await cached.getObservations("EURUSD", 61_001);
  assert.equal(inner.calls, 2, "provider must refresh after interval");
  console.log("cached-evidence-provider.test.ts: PASS");
}

void main();
