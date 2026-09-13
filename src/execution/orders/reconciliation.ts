import { Mt5FileBridge, Mt5Position } from "../../core/ai-bridge/mt5-file-bridge";
import { OrderRequest } from "../../core/types";
import { OrderStore } from "../../database/order-store";
import { env } from "../../config/env";

function isSameIdentity(position: Mt5Position, order: OrderRequest): boolean {
  return (
    position.symbol === order.symbol
    && position.side === order.side
    && position.comment === order.idempotencyKey
    && position.volume > 0
  );
}

export interface ReconciliationResult {
  safe: boolean;
  reasons: string[];
  activeOrders: OrderRequest[];
  terminalPositions: Mt5Position[];
  managedPositions: Mt5Position[];
}

/**
 * Reconciliation is deliberately conservative. Only positions carrying the
 * bot's configured magic number are managed. A durable order must be matched
 * by its short idempotency comment; symbol/side/volume alone is not a safe
 * identity because netting accounts and manual trades can otherwise collide.
 */
export async function reconcileOrders(
  bridge: Mt5FileBridge,
  store: OrderStore,
  expectedMagic: number,
  failedLookbackMs: number = env.reconciliationFailedLookbackMs,
): Promise<ReconciliationResult> {
  const [storedOrders, terminalPositions, recentFailedLive] = await Promise.all([
    store.listActive(),
    bridge.getPositions(),
    store.listRecentFailedLive(Date.now() - failedLookbackMs),
  ]);
  const managedPositions = terminalPositions.filter((position) => position.magic === expectedMagic);
  const reasons: string[] = [];

  // A client-side submitOrder() timeout marks the durable order FAILED
  // synchronously, in the same cycle, even when the broker still fills it
  // moments later. listActive() excludes FAILED orders on purpose (they're
  // terminal), so without this, such a position could never be matched back
  // to its order and would sit unmanaged forever, eventually tripping the
  // orphan-position safety check below. Only failed orders whose identity
  // still matches a live managed position are recovered; genuinely-failed
  // orders (no matching position) are left untouched.
  const recoverableFailedOrders = recentFailedLive.filter(
    (order) => order.executionEnvironment === "live" && managedPositions.some((position) => isSameIdentity(position, order)),
  );
  const activeOrders = [
    ...storedOrders.filter((order) => order.executionEnvironment === "live"),
    ...recoverableFailedOrders,
  ];

  if (managedPositions.some((position) => position.stopLoss <= 0 || position.takeProfit <= 0)) {
    reasons.push("managed MT5 position is missing a protective stop-loss or take-profit");
  }

  for (const order of activeOrders) {
    const matchingPosition = managedPositions.find((position) => isSameIdentity(position, order));

    if (["SUBMITTED", "CONFIRMED", "PARTIALLY_FILLED"].includes(order.state) && !matchingPosition) {
      reasons.push(`live order ${order.id} is not reconciled to an MT5 position`);
    }
    if (matchingPosition && matchingPosition.volume > order.volume + 1e-9) {
      reasons.push(`MT5 position ${matchingPosition.ticket} volume exceeds durable order ${order.id}`);
    }
    if (matchingPosition && order.state === "SUBMITTED") {
      // A broker can fill an order after the client times out. If the durable
      // order is still SUBMITTED but the exact idempotency identity is present
      // on the live position, recover the broker-confirmed state instead of
      // falsely treating the position as orphaned.
      if (store.updateExecution) {
        await store.updateExecution(order.id, matchingPosition.ticket, matchingPosition.openPrice, matchingPosition.volume);
      }
      await store.updateState(order.id, matchingPosition.volume + 1e-9 >= order.volume ? "FILLED" : "PARTIALLY_FILLED", "SUBMITTED");
    }
    if (matchingPosition && order.state === "FAILED") {
      // Same recovery as the SUBMITTED case above, but for an order the
      // client already gave up on after a timeout. The broker-confirmed
      // position is the source of truth.
      if (store.updateExecution) {
        await store.updateExecution(order.id, matchingPosition.ticket, matchingPosition.openPrice, matchingPosition.volume);
      }
      await store.updateState(order.id, matchingPosition.volume + 1e-9 >= order.volume ? "FILLED" : "PARTIALLY_FILLED", "FAILED");
    }
    if (matchingPosition && order.stopLoss !== null && Math.abs(matchingPosition.stopLoss - order.stopLoss) > 2e-5) {
      reasons.push(`MT5 position ${matchingPosition.ticket} stop-loss differs from durable order ${order.id}`);
    }
    if (matchingPosition && order.takeProfit !== null && Math.abs(matchingPosition.takeProfit - order.takeProfit) > 2e-5) {
      reasons.push(`MT5 position ${matchingPosition.ticket} take-profit differs from durable order ${order.id}`);
    }
    if (order.state === "FILLED" && !matchingPosition) {
      // The order was already broker-confirmed and can legitimately have been
      // closed between cycles. Marking it terminal prevents permanent blocks.
      await store.updateState(order.id, "CLOSED", "FILLED");
    }
  }

  for (const position of managedPositions) {
    const matchingOrder = activeOrders.find((order) =>
      order.symbol === position.symbol
      && order.side === position.side
      && order.idempotencyKey === position.comment
    );
    if (!matchingOrder) reasons.push(`managed MT5 position ${position.ticket} has no matching durable order`);
  }

  return { safe: reasons.length === 0, reasons, activeOrders, terminalPositions, managedPositions };
}
