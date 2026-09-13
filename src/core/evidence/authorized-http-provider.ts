import { EvidenceObservation } from "./types";
import { EvidenceProvider, NormalizedEvidenceResponse } from "./provider";

export interface AuthorizedHttpEvidenceProviderConfig {
  name: string;
  endpoint: string;
  apiKey?: string;
  required?: boolean;
  timeoutMs?: number;
}

export class AuthorizedHttpEvidenceProvider implements EvidenceProvider {
  readonly name: string;
  readonly required: boolean;
  private readonly timeoutMs: number;

  constructor(private readonly config: AuthorizedHttpEvidenceProviderConfig) {
    if (!config.name || !config.endpoint) throw new Error("evidence provider name and endpoint are required");
    this.name = config.name;
    this.required = config.required ?? true;
    this.timeoutMs = config.timeoutMs ?? 5_000;
  }

  async getObservations(symbol: string, now = Date.now()): Promise<EvidenceObservation[]> {
    const url = new URL(this.config.endpoint);
    url.searchParams.set("symbol", symbol);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
      });
      if (!response.ok) throw new Error(`${this.name} returned HTTP ${response.status}`);
      const payload = await response.json() as NormalizedEvidenceResponse;
      if (!payload || !Array.isArray(payload.observations)) throw new Error(`${this.name} returned an invalid normalized response`);
      return payload.observations.map((observation) => validateObservation(observation, this.name, symbol, now));
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateObservation(observation: EvidenceObservation, providerName: string, symbol: string, now: number): EvidenceObservation {
  if (observation.source !== providerName || observation.symbol !== symbol) throw new Error(`${providerName} returned an observation identity mismatch`);
  if (!Number.isFinite(observation.observedAtUtc) || !Number.isFinite(observation.validUntilUtc) || observation.validUntilUtc <= now) throw new Error(`${providerName} returned stale evidence`);
  if (![observation.strength, observation.confidence].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error(`${providerName} returned invalid confidence values`);
  return observation;
}
