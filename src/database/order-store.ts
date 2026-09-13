import { Collection, Db, MongoClient } from "mongodb";
import { OrderRequest, OrderState } from "../core/types";
import { env } from "../config/env";

export interface OrderStore {
  reserve(order: OrderRequest): Promise<OrderRequest | null>;
  updateState(orderId: string, state: OrderState, expectedState?: OrderState): Promise<void>;
  get(orderId: string): Promise<OrderRequest | null>;
  listActive(): Promise<OrderRequest[]>;
  updateExecution?(orderId: string, brokerOrderId: string, filledPrice: number, filledVolume: number): Promise<void>;
  // [FIX-ENTRY-RETRY] Persists whether a FAILED order is safe to retry (see
  // OrderRequest.retryable). Optional so existing OrderStore implementations
  // are unaffected; when absent, OrderManager keeps the classification
  // in-memory only, which still works within a single process lifetime.
  updateRetryable?(orderId: string, retryable: boolean): Promise<void>;
  // FAILED orders are excluded from listActive() by design (they're terminal),
  // but a client-side timeout can mark an order FAILED while the broker still
  // fills it. This bounded lookback lets reconciliation identity-match recent
  // FAILED orders against broker positions to recover that case. See
  // reconciliation.ts and env.reconciliationFailedLookbackMs.
  listRecentFailedLive(sinceUtc: number): Promise<OrderRequest[]>;
}

export class MongoOrderStore implements OrderStore {
  private readonly client: MongoClient;
  private readonly collection: Collection<OrderRequest>;

  constructor(uri = env.mongodbUri, databaseName = env.mongodbDatabase) {
    if (!uri) throw new Error("MONGODB_URI is required for MongoOrderStore");
    this.client = new MongoClient(uri, { retryWrites: true, retryReads: true, serverSelectionTimeoutMS: 5000 });
    const database: Db = this.client.db(databaseName);
    this.collection = database.collection<OrderRequest>("orders");
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.collection.createIndex({ idempotencyKey: 1 }, { unique: true });
    await this.collection.createIndex({ id: 1 }, { unique: true });
    await this.collection.createIndex({ state: 1, createdAtUtc: -1 });
  }

  async reserve(order: OrderRequest): Promise<OrderRequest | null> {
    try {
      await this.collection.insertOne(order);
      return order;
    } catch (error) {
      if (error instanceof Error && /duplicate key/i.test(error.message)) return null;
      throw error;
    }
  }

  async updateState(orderId: string, state: OrderState, expectedState?: OrderState): Promise<void> {
    const filter = expectedState ? { id: orderId, state: expectedState } : { id: orderId };
    const result = await this.collection.updateOne(filter, { $set: { state } });
    if (result.matchedCount !== 1) throw new Error(`durable order transition rejected for ${orderId}: expected ${expectedState ?? "any"}`);
  }

  async updateExecution(orderId: string, brokerOrderId: string, filledPrice: number, filledVolume: number): Promise<void> {
    const result = await this.collection.updateOne({ id: orderId }, { $set: { brokerOrderId, filledPrice, filledVolume } });
    if (result.matchedCount !== 1) throw new Error(`order ${orderId} not found while recording broker execution`);
  }

  async updateRetryable(orderId: string, retryable: boolean): Promise<void> {
    const result = await this.collection.updateOne({ id: orderId }, { $set: { retryable } });
    if (result.matchedCount !== 1) throw new Error(`order ${orderId} not found while recording retry classification`);
  }

  async get(orderId: string): Promise<OrderRequest | null> {
    return this.collection.findOne({ id: orderId });
  }

  async listActive(): Promise<OrderRequest[]> {
    return this.collection.find({ state: { $in: ["PROPOSED", "VALIDATING", "APPROVED", "SUBMITTED", "CONFIRMED", "PARTIALLY_FILLED", "FILLED"] } }).toArray();
  }

  async listRecentFailedLive(sinceUtc: number): Promise<OrderRequest[]> {
    return this.collection
      .find({ state: "FAILED", executionEnvironment: "live", createdAtUtc: { $gte: sinceUtc } })
      .toArray();
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
