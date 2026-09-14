import * as fs from "fs";
import * as path from "path";
import { AccountState } from "../risk/risk-engine";
import { Candle, OrderRequest, Quote, SymbolTradingSpec, Timeframe } from "../types";
import { ExecutionResult } from "../../execution/adapters/execution-adapter.interface";

export interface Mt5FileBridgeConfig {
  commonDirectory: string;
  secret: string;
  timeoutMs?: number;
  pollMs?: number;
  maxRequestAgeMs?: number;
}

export interface Mt5Identity {
  magicNumber: number;
  accountId: string;
  server: string;
  symbol?: string;
  timeframe?: string;
}

interface ResponseLine {
  requestId: string;
  status: "OK" | "ERROR";
  fields: string[];
}

export interface Mt5Reconciliation {
  account: AccountState;
  openPositionCount: number;
  positions: Mt5Position[];
  raw: string[];
}

export interface Mt5Position {
  ticket: string;
  magic: number;
  comment: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  openPrice: number;
  stopLoss: number;
  takeProfit: number;
}

export class Mt5FileBridge {
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly maxRequestAgeMs: number;
  private sequence = 0;
  private busy = false;

  constructor(private readonly config: Mt5FileBridgeConfig) {
    if (!config.commonDirectory || !config.secret || config.secret.length < 16) {
      throw new Error("MT5 file bridge requires a common directory and a secret of at least 16 characters");
    }
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.pollMs = config.pollMs ?? 50;
    this.maxRequestAgeMs = config.maxRequestAgeMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0 || !Number.isInteger(this.pollMs) || this.pollMs <= 0 || !Number.isInteger(this.maxRequestAgeMs) || this.maxRequestAgeMs < 1000 || this.timeoutMs > this.maxRequestAgeMs) {
      throw new Error("MT5 file bridge timeout/poll values must be positive integers and timeout must not exceed max request age");
    }
    fs.mkdirSync(config.commonDirectory, { recursive: true });
  }

  async isConnected(expectedMagic?: number, expectedAccountId?: string, expectedServer?: string): Promise<boolean> {
    try {
      const identity = await this.getIdentity();
      if (expectedMagic !== undefined) {
        if (identity.magicNumber !== expectedMagic) return false;
      }
      if (expectedAccountId !== undefined) {
        if (identity.accountId !== expectedAccountId) return false;
      }
      if (expectedServer !== undefined) {
        if (identity.server !== expectedServer) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async getIdentity(): Promise<Mt5Identity> {
    const response = await this.request("PING");
    const pong = response.find((line) => line.fields[0] === "PONG");
    if (!pong || pong.fields.length < 4) throw new Error("MT5 returned no valid identity");
    const magicNumber = Number(pong.fields[1]);
    if (!Number.isInteger(magicNumber) || !pong.fields[2] || !pong.fields[3]) throw new Error("MT5 returned malformed identity");
    return {
      magicNumber,
      accountId: pong.fields[2],
      server: pong.fields[3],
      symbol: pong.fields[4] || undefined,
      timeframe: pong.fields[5] || undefined,
    };
  }

  async getHistoricalCandles(symbol: string, timeframe: Timeframe, count: number): Promise<Candle[]> {
    if (!Number.isInteger(count) || count < 2 || count > 100_000) throw new Error("invalid MT5 history count");
    const response = await this.request("HISTORY", symbol, timeframe, String(count));
    const candles: Candle[] = [];
    for (const line of response) {
      if (line.fields[0] !== "C" || line.fields.length !== 8) continue;
      const timestampUtc = Number(line.fields[1]);
      const open = Number(line.fields[2]);
      const high = Number(line.fields[3]);
      const low = Number(line.fields[4]);
      const close = Number(line.fields[5]);
      const volume = Number(line.fields[6]);
      const isClosed = line.fields[7] === "1";
      if (![timestampUtc, open, high, low, close, volume].every(Number.isFinite)) throw new Error("MT5 returned malformed candle data");
      candles.push({ symbol, timeframe, timestampUtc, open, high, low, close, volume, isClosed });
    }
    if (candles.length === 0) throw new Error("MT5 returned no candles");
    return candles;
  }

  async resolveSymbol(symbol: string): Promise<string> {
    const response = await this.request("RESOLVE", symbol);
    const line = response.find((item) => item.fields[0] === "R");
    if (!line || line.fields.length !== 2 || !line.fields[1]) throw new Error(`MT5 could not resolve broker symbol '${symbol}'`);
    return line.fields[1];
  }

  async getLatestQuote(symbol: string): Promise<Quote> {
    const response = await this.request("QUOTE", symbol);
    const line = response.find((item) => item.fields[0] === "Q");
    if (!line || line.fields.length !== 5) throw new Error("MT5 returned no quote");
    const timestampUtc = Number(line.fields[1]);
    const bid = Number(line.fields[2]);
    const ask = Number(line.fields[3]);
    const spread = Number(line.fields[4]);
    if (!Number.isFinite(timestampUtc) || !Number.isFinite(bid) || !Number.isFinite(ask) || !Number.isFinite(spread) || bid <= 0 || ask < bid || spread < 0) {
      throw new Error("MT5 returned malformed quote");
    }
    return { symbol, timestampUtc, bid, ask, spread };
  }

  async getTradingSpec(symbol: string, side: "BUY" | "SELL", entryPrice: number, stopLossPrice: number): Promise<SymbolTradingSpec> {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(stopLossPrice) || stopLossPrice <= 0) {
      throw new Error("invalid entry/stop prices for MT5 trading specification");
    }
    const response = await this.request("SYMBOL", symbol, side, String(entryPrice), String(stopLossPrice));
    const line = response.find((item) => item.fields[0] === "S");
    if (!line || line.fields.length !== 11) throw new Error("MT5 returned no symbol trading specification");
    const values = line.fields.slice(1).map(Number);
    // `line.fields.length === 11` above guarantees exactly 10 elements
    // here, and `.every(Number.isFinite)` guarantees each is a finite
    // number — but TS (correctly, under noUncheckedIndexedAccess) can't
    // narrow array-destructured elements past `number | undefined` on
    // its own. `at()` makes that already-proven guarantee explicit to
    // the type checker instead of casting past it.
    if (values.length !== 10 || !values.every(Number.isFinite)) throw new Error("MT5 returned malformed symbol trading specification");
    const at = (i: number): number => {
      const v = values[i];
      if (v === undefined) throw new Error("MT5 returned malformed symbol trading specification");
      return v;
    };
    const digits = at(0);
    const point = at(1);
    const tickSize = at(2);
    const tickValue = at(3);
    const volumeMin = at(4);
    const volumeMax = at(5);
    const volumeStep = at(6);
    const stopsLevelPoints = at(7);
    const freezeLevelPoints = at(8);
    const lossPerLotAtStop = at(9);
    if (!Number.isInteger(digits) || digits < 0 || point <= 0 || tickSize <= 0 || tickValue < 0 || volumeMin <= 0 || volumeMax < volumeMin || volumeStep <= 0 || stopsLevelPoints < 0 || freezeLevelPoints < 0 || lossPerLotAtStop <= 0) {
      throw new Error("MT5 returned invalid symbol trading specification");
    }
    return { digits, point, tickSize, tickValue, volumeMin, volumeMax, volumeStep, stopsLevelPoints, freezeLevelPoints, lossPerLotAtStop };
  }

  async getAccount(): Promise<Mt5Reconciliation> {
    const response = await this.request("ACCOUNT");
    const line = response.find((item) => item.fields[0] === "A");
    if (!line || line.fields.length !== 5) throw new Error("MT5 returned no account state");
    const balance = Number(line.fields[1]);
    const equity = Number(line.fields[2]);
    const freeMargin = Number(line.fields[3]);
    const openPositionsCount = Number(line.fields[4]);
    if (![balance, equity, freeMargin, openPositionsCount].every(Number.isFinite) || equity <= 0 || freeMargin < 0 || openPositionsCount < 0) {
      throw new Error("MT5 returned malformed account state");
    }
    return {
      account: { balance, equity, freeMargin, openPositionsCount, dailyLossPct: 0, currentDrawdownPct: 0 },
      openPositionCount: openPositionsCount,
      positions: [],
      raw: response.map((item) => item.fields.join("|")),
    };
  }

  async getPositions(): Promise<Mt5Position[]> {
    const response = await this.request("POSITIONS");
    // [FIX-POSITIONS-FIELD-COUNT] The EA writes exactly 10 fields per "P"
    // line — P,ticket,magic,side,volume,open_price,stop_loss,take_profit,
    // symbol,comment (see AITradingBot.mq5's HandlePositions) — not 11.
    // This mismatch meant every non-empty POSITIONS response was rejected
    // as "malformed", and reconciliation.ts calls getPositions() on every
    // single cycle. Verified against the actual StringFormat call site,
    // field by field, not assumed.
    return response.filter((line) => line.fields[0] === "P").map((line) => {
      if (line.fields.length !== 10) throw new Error("MT5 returned malformed position data");
      const ticket = line.fields[1] ?? "";
      const magic = Number(line.fields[2]);
      const side = line.fields[3];
      const volume = Number(line.fields[4]);
      const openPrice = Number(line.fields[5]);
      const stopLoss = Number(line.fields[6]);
      const takeProfit = Number(line.fields[7]);
      const symbol = line.fields[8] ?? "";
      const comment = line.fields[9] ?? "";
      if (!ticket || !Number.isInteger(magic) || (side !== "BUY" && side !== "SELL") || ![volume, openPrice, stopLoss, takeProfit].every(Number.isFinite) || volume <= 0 || openPrice <= 0 || !symbol) {
        throw new Error("MT5 returned invalid position values");
      }
      return { ticket, magic, comment, symbol, side, volume, openPrice, stopLoss, takeProfit };
    });
  }

  async submitOrder(order: OrderRequest): Promise<ExecutionResult> {
    try {
      const response = await this.request("ORDER", order.id, order.symbol, order.side, String(order.volume), String(order.stopLoss), String(order.takeProfit), order.idempotencyKey);
      const line = response.find((item) => item.fields[0] === "O");
      // The EA only reaches WriteResponse(..., "O|...") after Trade.Buy/Sell
      // has already returned a broker-confirmed retcode (see HandleOrder in
      // AITradingBot.mq5) — an "OK" status here means the position exists at
      // the broker even if these fields are malformed. That ambiguity can
      // only be resolved by reconciliation.ts matching this order's
      // idempotency comment against live MT5 positions, never by retrying.
      if (!line || line.fields.length !== 5) return { success: false, brokerOrderId: null, filledPrice: null, filledVolume: null, error: "malformed MT5 order response", retryable: false, rawResponse: response };
      const orderTicket = line.fields[1] ?? "";
      const dealId = line.fields[2] ?? "";
      const brokerOrderId = orderTicket !== "0" && orderTicket !== "" ? orderTicket : dealId;
      const filledPrice = Number(line.fields[3]);
      const filledVolume = Number(line.fields[4]);
      const valid = brokerOrderId.length > 0 && Number.isFinite(filledPrice) && filledPrice > 0 && Number.isFinite(filledVolume) && filledVolume > 0;
      return valid
        ? { success: true, brokerOrderId, filledPrice, filledVolume, error: null, rawResponse: { lines: response, dealId } }
        : { success: false, brokerOrderId: null, filledPrice: null, filledVolume: null, error: "invalid MT5 fill values", retryable: false, rawResponse: { lines: response, dealId } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // [FIX-ENTRY-RETRY] Distinguish a DEFINITIVE decline from an AMBIGUOUS
      // one. request() throws "MT5 bridge error: ..." only when the EA
      // itself read the request and explicitly returned an ERROR status —
      // every WriteError() call in HandleOrder happens strictly before
      // Trade.Buy/Sell is invoked (invalid params, duplicate idempotency
      // key, broker-rejected retcode, stop/target/margin validation), so no
      // position was opened. The "one in-flight request at a time" guard in
      // request() also fires before the request file is even written, so it
      // is equally certain nothing reached the broker. Every other failure
      // here — a bridge timeout, a malformed/unparseable response, a
      // request-id mismatch, a filesystem error — leaves the true broker
      // outcome unknown, so it must default to non-retryable and be left to
      // reconciliation.ts, exactly like the two ambiguous cases above.
      const retryable = message.startsWith("MT5 bridge error:") || message === "MT5 bridge supports one in-flight request at a time";
      return { success: false, brokerOrderId: null, filledPrice: null, filledVolume: null, error: message, retryable, rawResponse: null };
    }
  }

  private async request(operation: string, ...fields: string[]): Promise<ResponseLine[]> {
    if (this.busy) throw new Error("MT5 bridge supports one in-flight request at a time");
    this.busy = true;
    const requestId = `req_${Date.now()}_${++this.sequence}`;
    const requestPath = path.join(this.config.commonDirectory, "ai_trading_request.txt");
    const responsePath = path.join(this.config.commonDirectory, "ai_trading_response.txt");
    const tempPath = `${requestPath}.${requestId}.tmp`;
    const payload = [requestId, this.config.secret, operation, ...fields].join("|") + "\n";
    try {
      if (fs.existsSync(responsePath)) fs.rmSync(responsePath, { force: true });
      fs.writeFileSync(tempPath, payload, { encoding: "ascii", flag: "wx" });
      fs.renameSync(tempPath, requestPath);
      const started = Date.now();
      while (Date.now() - started < this.timeoutMs) {
        if (fs.existsSync(responsePath)) {
          const lines = fs.readFileSync(responsePath, "ascii").trim().split(/\r?\n/).filter(Boolean);
          fs.rmSync(responsePath, { force: true });
          const parsed = lines.map((line) => {
            const parts = line.split("|");
            const status = parts[1];
            if (status !== "OK" && status !== "ERROR") throw new Error("MT5 response has an invalid status");
            return { requestId: parts[0] ?? "", status: status as "OK" | "ERROR", fields: parts.slice(2) };
          });
          if (parsed.length === 0) throw new Error("MT5 returned an empty response");
          if (parsed.some((line) => line.requestId !== requestId)) throw new Error("MT5 response request ID mismatch");
          const errorLine = parsed.find((line) => line.status === "ERROR");
          if (errorLine) throw new Error(`MT5 bridge error: ${errorLine.fields.join("|")}`);
          return parsed;
        }
        await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      }
      throw new Error(`MT5 bridge timeout after ${this.timeoutMs}ms`);
    } finally {
      this.busy = false;
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    }
  }
}