import { env, requireEnv } from "../config/env";
import * as fs from "fs";
import * as path from "path";
import { MarketDataProvider } from "../core/market-data/providers/market-data-provider.interface";
import { Mt5MarketDataProvider } from "../core/market-data/providers/mt5-market-data.provider";
import { createResearchProvider } from "../core/market-data/providers/provider-registry";
import { Timeframe } from "../core/types";

/**
 * Writes candles from ANY MarketDataProvider to a standard CSV under
 * data/raw/. This is the seam between the TS engine and the Python
 * training pipeline — Python never talks to a provider directly, it
 * only reads these files, so swapping the dev provider for MT5/vendor
 * later requires no change on the Python side.
 *
 * The output filename and the `source` column make it impossible to
 * mistake a dev/synthetic export for a real one.
 */
async function exportHistoricalData(provider: MarketDataProvider, symbol: string, timeframe: Timeframe, count: number) {
  const candles = await provider.getHistoricalCandles(symbol, timeframe, count);
  const outDir = path.join(__dirname, "../../data/raw");
  fs.mkdirSync(outDir, { recursive: true });

  const sourceTag = provider.isDevProvider ? "dev-synthetic" : provider.name;
  const outFile = path.join(outDir, `${symbol}_${timeframe}_${sourceTag}.csv`);

  const header = "timestamp_utc,symbol,timeframe,open,high,low,close,volume,is_closed,source\n";
  const rows = candles
    .map((c) => [c.timestampUtc, c.symbol, c.timeframe, c.open, c.high, c.low, c.close, c.volume, c.isClosed ? 1 : 0, sourceTag].join(","))
    .join("\n");

  fs.writeFileSync(outFile, header + rows + "\n", "utf-8");
  console.log(`wrote ${candles.length} candles to ${outFile} (source=${sourceTag})`);
  return outFile;
}

function timeframeArg(value: string): Timeframe {
  if (!["M1", "M5", "M15", "H1", "H4", "D1"].includes(value)) throw new Error(`unsupported timeframe: ${value}`);
  return value as Timeframe;
}

async function main() {
  const symbol = process.argv[2] ?? env.mt5Symbol;
  const selectedTimeframe = timeframeArg(process.argv[3] ?? env.mt5Timeframe);
  const count = Number(process.argv[4] ?? 6000);
  if (!Number.isInteger(count) || count < 2 || count > 100_000) throw new Error("count must be an integer between 2 and 100000");

  // MT5 is the default/authoritative execution-side source. For research
  // exports, VENDOR_DATA_PROVIDER may explicitly select a real public/vendor
  // adapter. There is never a synthetic fallback.
  let provider: MarketDataProvider;
  if (env.vendorDataProvider === "mt5") {
    const commonDirectory = requireEnv("mt5CommonDirectory");
    provider = new Mt5MarketDataProvider({
      accountId: requireEnv("mt5AccountId"),
      server: requireEnv("mt5Server"),
      commonDirectory,
      bridgeSecret: requireEnv("mt5BridgeSecret"),
      magicNumber: env.mt5MagicNumber,
    });
    if (!(await provider.isConnected())) throw new Error("MT5 EA bridge is not connected; verify MT5_COMMON_DIRECTORY and MT5_BRIDGE_SECRET.");
  } else {
    const apiKey = env.vendorDataApiKey || (env.vendorDataProvider === "twelvedata" ? env.twelveDataApiKey : env.vendorDataProvider === "binance" ? env.binanceApiKey : "");
    provider = createResearchProvider(env.vendorDataProvider, { apiKey, timeoutMs: env.mt5BridgeTimeoutMs, probeSymbol: symbol });
    if (!(await provider.isConnected())) throw new Error(`research market-data provider '${env.vendorDataProvider}' is not reachable/configured`);
  }

  await exportHistoricalData(provider, symbol, selectedTimeframe, count);
}

main().catch((err) => {
  console.error("export failed:", err);
  throw err;
});
