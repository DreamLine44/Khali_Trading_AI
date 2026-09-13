import { Collection, Db, MongoClient } from "mongodb";
import { AccountState } from "../core/risk/risk-engine";
import { env } from "../config/env";

interface AccountSnapshot extends AccountState {
  accountId: string;
  timestampUtc: number;
}

export class MongoAccountStore {
  private readonly client: MongoClient;
  private readonly collection: Collection<AccountSnapshot>;

  constructor(uri = env.mongodbUri, databaseName = env.mongodbDatabase) {
    if (!uri) throw new Error("MONGODB_URI is required for MongoAccountStore");
    this.client = new MongoClient(uri, { retryWrites: true, retryReads: true });
    const database: Db = this.client.db(databaseName);
    this.collection = database.collection<AccountSnapshot>("account_snapshots");
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.collection.createIndex({ accountId: 1, timestampUtc: -1 });
  }

  async enrich(accountId: string, account: AccountState, now = Date.now()): Promise<AccountState> {
    const startOfDay = new Date(new Date(now).setUTCHours(0, 0, 0, 0)).getTime();
    const [dayStart, peak] = await Promise.all([
      this.collection.findOne({ accountId, timestampUtc: { $gte: startOfDay, $lte: now } }, { sort: { timestampUtc: 1 } }),
      this.collection.findOne({ accountId, timestampUtc: { $lte: now } }, { sort: { equity: -1 } }),
    ]);
    const dayStartEquity = dayStart?.equity ?? account.equity;
    const peakEquity = Math.max(peak?.equity ?? account.equity, account.equity);
    return {
      ...account,
      dailyLossPct: dayStartEquity > 0 ? (account.equity - dayStartEquity) / dayStartEquity : 0,
      currentDrawdownPct: peakEquity > 0 ? (peakEquity - account.equity) / peakEquity : 0,
    };
  }

  async record(accountId: string, account: AccountState, timestampUtc = Date.now()): Promise<void> {
    await this.collection.insertOne({ ...account, accountId, timestampUtc });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
