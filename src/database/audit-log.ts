import * as fs from "fs";
import * as path from "path";
import { Collection, Db, MongoClient } from "mongodb";
import { AuditRecord } from "../core/types";
import { env } from "../config/env";

export interface AuditLog {
  append(record: AuditRecord): Promise<void>;
}

export class MongoAuditLog implements AuditLog {
  private readonly client: MongoClient;
  private readonly collection: Collection<AuditRecord>;

  constructor(uri = env.mongodbUri, databaseName = env.mongodbDatabase, instanceId = env.tradingInstanceId) {
    if (!uri) {
      throw new Error("MONGODB_URI is required for MongoAuditLog");
    }
    this.client = new MongoClient(uri, { retryWrites: true, retryReads: true });
    const database: Db = this.client.db(databaseName);
    const collectionName = instanceId === "default" ? "trade_decisions" : `trade_decisions_${instanceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    this.collection = database.collection<AuditRecord>(collectionName);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.collection.createIndex({ "decision.id": 1 }, { unique: true });
    await this.collection.createIndex({ "decision.createdAtUtc": -1 });
    await this.collection.createIndex({ "decision.symbol": 1, "decision.timeframe": 1, "decision.createdAtUtc": -1 });
  }

  async append(record: AuditRecord): Promise<void> {
    try {
      await this.collection.insertOne(record);
    } catch (error) {
      // The loop can poll the same still-forming candle more than once. The
      // decision ID is intentionally candle-scoped, so replaying the same
      // decision is an idempotent no-op; unrelated MongoDB failures must still
      // propagate and trip the safety circuit breaker.
      if (error instanceof Error && /duplicate key/i.test(error.message)) return;
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** Development-only sink. It is not a substitute for MongoDB in paper/live operation. */
export class JsonlAuditLog implements AuditLog {
  constructor(private readonly filePath: string = path.join(__dirname, "../../monitoring/logs/audit.jsonl")) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  async append(record: AuditRecord): Promise<void> {
    fs.appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf-8");
  }
}
