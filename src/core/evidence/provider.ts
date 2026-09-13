import { EvidenceObservation } from "./types";

export interface EvidenceProvider {
  readonly name: string;
  readonly required: boolean;
  getObservations(symbol: string, now?: number): Promise<EvidenceObservation[]>;
}

export interface NormalizedEvidenceResponse {
  observations: EvidenceObservation[];
}
