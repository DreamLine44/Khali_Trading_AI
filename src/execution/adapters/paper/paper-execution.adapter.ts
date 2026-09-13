import { OrderRequest } from "../../../core/types";
import { ExecutionAdapter, ExecutionResult } from "../execution-adapter.interface";

/**
 * Simulated execution — no real orders reach a broker. This MUST remain
 * the default adapter until backtesting + paper-trading validation is
 * complete (spec section 35). Switching to the MT5 adapter is an
 * explicit, separate configuration step — never a silent fallback.
 */
export class PaperExecutionAdapter implements ExecutionAdapter {
  readonly name = "paper";
  readonly isLive = false;

  async submitOrder(order: OrderRequest): Promise<ExecutionResult> {
    // Simulate a fill at a nominal price with zero slippage for now.
    // A realistic paper engine needs spread/slippage/commission
    // modeling — see backtesting/costs/ for where that logic belongs
    // once this is promoted beyond a pipeline smoke test.
    //
    // [FIX-PAPER-FILL] This used to return filledPrice: null despite the
    // comment above promising a simulated fill price. trading-loop.ts
    // treated that null as an acceptable non-live result, so the order was
    // transitioned to CONFIRMED/FILLED without ever calling
    // recordExecution() (which requires a non-null price) — every paper
    // "fill" silently lost its brokerOrderId/filledPrice/filledVolume.
    // Fail closed instead of fabricating a price when none is available.
    if (!Number.isFinite(order.referencePrice) || (order.referencePrice as number) <= 0) {
      return {
        success: false,
        brokerOrderId: null,
        filledPrice: null,
        filledVolume: null,
        error: "paper execution adapter has no valid reference price to simulate a fill",
        // [FIX-ENTRY-RETRY] Nothing here ever touches a real broker, so
        // there is no ambiguity to preserve — always safe to retry once a
        // fresh quote is available.
        retryable: true,
        rawResponse: { simulated: true, order },
      };
    }
    return {
      success: true,
      brokerOrderId: `paper_${order.id}`,
      filledPrice: order.referencePrice,
      filledVolume: order.volume,
      error: null,
      rawResponse: { simulated: true, order },
    };
  }
}
