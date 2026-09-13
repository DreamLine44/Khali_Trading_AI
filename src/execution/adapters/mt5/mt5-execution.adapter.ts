import { Mt5FileBridge } from "../../../core/ai-bridge/mt5-file-bridge";
import { OrderRequest } from "../../../core/types";
import { ExecutionAdapter, ExecutionResult } from "../execution-adapter.interface";

export class Mt5ExecutionAdapter implements ExecutionAdapter {
  readonly name = "mt5-file-bridge";
  readonly isLive = true;

  constructor(private readonly bridge: Mt5FileBridge) {}

  async submitOrder(order: OrderRequest): Promise<ExecutionResult> {
    if (order.executionEnvironment !== "live") {
      // [FIX-ENTRY-RETRY] Rejected before the bridge is ever touched, so
      // this is 100% certain to have never reached the broker.
      return { success: false, brokerOrderId: null, filledPrice: null, filledVolume: null, error: "MT5 execution adapter refuses non-live orders", retryable: true, rawResponse: null };
    }
    if (!order.stopLoss || !order.takeProfit || order.volume <= 0) {
      return { success: false, brokerOrderId: null, filledPrice: null, filledVolume: null, error: "MT5 execution adapter refuses orders without protective SL/TP and positive volume", retryable: true, rawResponse: null };
    }
    return this.bridge.submitOrder(order);
  }
}
