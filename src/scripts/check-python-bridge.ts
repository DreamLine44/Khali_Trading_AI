import "../config/env";
import * as fs from "fs";
import * as path from "path";
import { getPythonModelPrediction } from "../core/ai-bridge/python-model-bridge";

/** Reads the last row of the processed feature CSV so this uses a real
 * (dev-synthetic) feature vector rather than fabricating one. */
function readLastFeatureRow(csvPath: string, columns: string[]): Record<string, number> {
  const content = fs.readFileSync(csvPath, "utf-8").trim().split("\n");
  const header = content[0]!.split(",");
  const lastLine = content[content.length - 1]!.split(",");
  const row: Record<string, number> = {};
  for (const col of columns) {
    const idx = header.indexOf(col);
    if (idx === -1) throw new Error(`column ${col} not found in ${csvPath}`);
    row[col] = parseFloat(lastLine[idx]!);
  }
  return row;
}

// [FIX-STALE-FEATURE-LIST] This used to hardcode a 14-column feature list
// left over from an earlier, smaller feature schema. The model has grown to
// 34 columns since (see feature-vector.ts's toModelFeatureRow), so every
// call this script made to the development stage failed with "feature row
// missing required columns" — a script nobody runs in the test suite
// (npm run test:ts never invokes it) silently rotted. Reading the schema
// from the development model's own metadata sidecar means this can't drift
// out of sync with the model again.
function readDevelopmentFeatureSchema(symbol: string, timeframe: string): string[] {
  const developmentDir = path.join(__dirname, "../../models/development");
  const candidates = fs
    .readdirSync(developmentDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${symbol}_${timeframe}_`) && entry.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (candidates.length === 0) throw new Error(`no development model metadata found for ${symbol}/${timeframe}`);
  const metadataPath = path.join(developmentDir, candidates.at(-1)!.name);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
  if (!Array.isArray(metadata.feature_schema) || metadata.feature_schema.length === 0) {
    throw new Error(`development model metadata at ${metadataPath} has no feature_schema`);
  }
  return metadata.feature_schema as string[];
}

async function main() {
  const csvPath = path.join(__dirname, "../../data/processed/EURUSD_M15_dev-synthetic_features.csv");
  const featureColumns = readDevelopmentFeatureSchema("EURUSD", "M15");
  const row = readLastFeatureRow(csvPath, featureColumns);

  console.log("Calling Python bridge for 'development' stage...");
  const prediction = await getPythonModelPrediction("development", "EURUSD", "M15", row);
  console.log(JSON.stringify(prediction, null, 2));

  console.log("\nCalling Python bridge for 'production' stage (expecting fail-safe rejection)...");
  let rejected = false;
  try {
    await getPythonModelPrediction("production", "EURUSD", "M15", row);
  } catch (err) {
    rejected = true;
    console.log(`correctly rejected: ${(err as Error).message}`);
  }
  if (!rejected) {
    throw new Error("production model unexpectedly available");
  }
}

main().catch((err) => {
  console.error("bridge check failed:", err);
  throw err;
});
