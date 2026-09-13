import { OrderRequest } from "../../core/types";

export interface ExecutionResult {
  success: boolean;
  brokerOrderId: string | null;
  filledPrice: number | null;
  filledVolume: number | null;
  error: string | null;
  rawResponse: unknown;
  // [FIX-ENTRY-RETRY] Only meaningful when success is false. True means the
  // adapter can PROVE the order never reached the broker (e.g. a bridge
  // request/config validation failure, or an explicit EA-side decline
  // before Trade.Buy/Sell was ever called) — safe to attempt the same
  // decision again with a fresh quote on a later cycle. False or omitted
  // means the outcome is ambiguous (timeout, malformed-but-OK response,
  // etc.) and retrying could risk a duplicate live position; reconciliation
  // is the only safe way to resolve that case. Adapters must default to
  // false/omitted when unsure — never guess true.
  retryable?: boolean;
}

/**
 * Every place an order is actually sent to a market goes through this
 * interface — paper adapter for development/testing, MT5 adapter (via
 * the MQL5 bridge) for real execution. The orchestrator must never
 * assume success without a confirmed ExecutionResult (spec section 21).
 */
export interface ExecutionAdapter {
  readonly name: string;
  readonly isLive: boolean;
  submitOrder(order: OrderRequest): Promise<ExecutionResult>;
}
