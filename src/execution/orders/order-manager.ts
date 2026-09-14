import { createHash } from "crypto";
import { Decision, OrderRequest, OrderState, RiskCheckResult } from "../../core/types";
import { OrderStore } from "../../database/order-store";

const VALID_TRANSITIONS: Record<OrderState, OrderState[]> = {
  PROPOSED: ["VALIDATING", "REJECTED"],
  VALIDATING: ["APPROVED", "REJECTED"],
  APPROVED: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["CONFIRMED", "FAILED"],
  CONFIRMED: ["FILLED", "PARTIALLY_FILLED", "FAILED"],
  FILLED: ["CLOSED"],
  PARTIALLY_FILLED: ["FILLED", "CLOSED", "FAILED"],
  REJECTED: [],
  CANCELLED: [],
  CLOSED: [],
  FAILED: [],
};

/**
 * Owns order lifecycle + idempotency. The same decision must never
 * produce two live orders that BOTH reach the broker — `seenIdempotencyKeys`
 * plus the store's unique index are the guard for that (spec section 22).
 * In production this must be backed by a durable store (DB), not only an
 * in-memory Set, so a process restart can't forget what it already
 * submitted.
 *
 * [FIX-ENTRY-RETRY] A single decision is allowed up to MAX_ENTRY_ATTEMPTS
 * distinct order attempts, each with its own idempotency key, but ONLY when
 * every prior attempt for that decision ended in a DEFINITIVE, non-ambiguous
 * failure (order.retryable === true — see ExecutionResult.retryable). This
 * targets a real gap: the MT5 file bridge is a polled, single-in-flight,
 * multi-round-trip channel (EA timer default 1s; HISTORY, QUOTE, SYMBOL,
 * ORDER are sequential), so several seconds can pass between the quote used
 * to size a stop/target and the broker actually evaluating the order. A
 * broker-side rejection caused purely by that price drift (e.g. "stop or
 * target violates broker minimum/freeze distance") used to permanently burn
 * the decision's one idempotency slot, silently discarding an otherwise
 * valid signal for the rest of that candle (up to the full timeframe
 * period) even though the trading loop naturally revisits the same decision
 * every mt5PollIntervalMs with a fresh quote. Any outcome that is not
 * definitively known to have missed the broker (timeouts, malformed-but-OK
 * responses, etc.) still permanently locks the slot, same as before.
 */
export class OrderManager {
  private static readonly MAX_ENTRY_ATTEMPTS = 3;

  private readonly seenIdempotencyKeys = new Set<string>();
  private readonly orders = new Map<string, OrderRequest>();

  constructor(
    private readonly store?: OrderStore,
    private readonly executionEnvironment: "paper" | "live" = "paper",
    private readonly instanceId = "default",
  ) {}

  private async lookupOrder(orderId: string): Promise<OrderRequest | null> {
    return this.orders.get(orderId) ?? (this.store ? await this.store.get(orderId) : null) ?? null;
  }

  async createOrderFromDecision(decision: Decision, risk: RiskCheckResult, referencePrice: number | null = null): Promise<OrderRequest | null> {
    if (!risk.approved || (decision.action !== "BUY" && decision.action !== "SELL")) {
      return null;
    }
    if (!Number.isFinite(risk.maxPositionSize) || risk.maxPositionSize === null || risk.maxPositionSize <= 0) {
      return null;
    }
    if (!Number.isFinite(risk.stopLossPrice) || risk.stopLossPrice === null || risk.stopLossPrice <= 0) {
      return null;
    }
    if (!Number.isFinite(risk.takeProfitPrice) || risk.takeProfitPrice === null || risk.takeProfitPrice <= 0) {
      return null;
    }
    const instanceKey = createHash("sha256").update(this.instanceId).digest("hex").slice(0, 8);
    const signalKey = createHash("sha256").update(`${this.instanceId}:${decision.id}:${decision.action}`).digest("hex").slice(0, 16);
    const normalizedReferencePrice = Number.isFinite(referencePrice) && (referencePrice as number) > 0 ? referencePrice : null;

    for (let attempt = 1; attempt <= OrderManager.MAX_ENTRY_ATTEMPTS; attempt++) {
      // MT5 limits position comments/idempotency keys to 31 characters.
      // Keep a compact tenant fingerprint in the broker-visible key while
      // retaining the full instance identity in durable Mongo namespaces.
      const idempotencyKey = this.instanceId === "default"
        ? `AI_${createHash("sha256").update(`${decision.id}:${decision.action}`).digest("hex").slice(0, 20)}_${attempt}`
        : `AI_${instanceKey}_${signalKey}_${attempt}`;
      const orderId = this.instanceId === "default" ? `ord_${idempotencyKey}` : `ord_${this.instanceId}_${signalKey}_${attempt}`;
      const existing = await this.lookupOrder(orderId);
      if (existing) {
        // A prior attempt for this exact decision already occupies this
        // slot. Move on to the next attempt ONLY if it is a confirmed,
        // definitively-non-broker failure; anything else (still in flight,
        // already succeeded, or an ambiguous failure) must never be
        // superseded by a fresh order for the same decision.
        if (existing.state === "FAILED" && existing.retryable === true) continue;
        return null;
      }

      const order: OrderRequest = {
        id: orderId,
        decisionId: decision.id,
        symbol: decision.symbol,
        side: decision.action,
        volume: risk.maxPositionSize,
        stopLoss: risk.stopLossPrice,
        takeProfit: risk.takeProfitPrice,
        state: "PROPOSED",
        createdAtUtc: Date.now(),
        idempotencyKey,
        executionEnvironment: this.executionEnvironment,
        // [FIX-PAPER-FILL] Carried through so a paper-mode fill can be
        // simulated at a real price instead of reporting null (spec section 35).
        referencePrice: normalizedReferencePrice,
      };
      if (this.store) {
        const reserved = await this.store.reserve(order);
        if (!reserved) return null; // another process/cycle already claimed this exact attempt slot
      }
      this.seenIdempotencyKeys.add(order.idempotencyKey);
      this.orders.set(order.id, order);
      return order;
    }
    return null; // every attempt for this decision is exhausted or unresolved
  }

  /**
   * [FIX-ENTRY-RETRY] Records whether a just-FAILED order is safe to retry.
   * Must only be called with retryable=true when the caller can PROVE the
   * order never reached the broker — see ExecutionResult.retryable for the
   * exact conditions. Safe to call for paper orders too; it is simply never
   * consulted for anything but live decisions in practice.
   */
  async recordFailureClassification(orderId: string, retryable: boolean): Promise<void> {
    const order = await this.lookupOrder(orderId);
    if (!order) return;
    order.retryable = retryable;
    this.orders.set(order.id, order);
    if (this.store?.updateRetryable) await this.store.updateRetryable(orderId, retryable);
  }

  async transition(orderId: string, next: OrderState): Promise<OrderRequest> {
    let order = this.orders.get(orderId);
    if (!order && this.store) {
      const durable = await this.store.get(orderId);
      if (durable) {
        order = durable;
        this.orders.set(order.id, order);
        this.seenIdempotencyKeys.add(order.idempotencyKey);
      }
    }
    if (!order) throw new Error(`unknown order ${orderId}`);
    const allowed = VALID_TRANSITIONS[order.state];
    if (!allowed.includes(next)) {
      throw new Error(`illegal order transition ${order.state} -> ${next} for ${orderId}`);
    }
    const previousState = order.state;
    if (this.store) await this.store.updateState(orderId, next, previousState);
    order.state = next;
    return order;
  }

  async recordExecution(orderId: string, result: { brokerOrderId: string; filledPrice: number; filledVolume: number }): Promise<void> {
    const order = this.orders.get(orderId) ?? (this.store ? await this.store.get(orderId) : null);
    if (!order) throw new Error(`unknown order ${orderId}`);
    if (this.store?.updateExecution) await this.store.updateExecution(orderId, result.brokerOrderId, result.filledPrice, result.filledVolume);
    order.brokerOrderId = result.brokerOrderId;
    order.filledPrice = result.filledPrice;
    order.filledVolume = result.filledVolume;
    this.orders.set(order.id, order);
  }

  get(orderId: string): OrderRequest | undefined {
    return this.orders.get(orderId);
  }
}
