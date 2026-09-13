import { spawn } from "child_process";
import * as path from "path";
import { ModelPrediction } from "../types";
import { env } from "../../config/env";

/** Per-feature {mean, std} the model was trained on, keyed by the exact
 * feature-row names produced by toModelFeatureRow() (see
 * core/features/feature-vector.ts) — used by DriftMonitor to detect live
 * feature drift against what the model actually saw during training. */
export type FeatureBaselineStats = Record<string, { mean: number; std: number }>;

export interface MlModelPrediction extends ModelPrediction {
  featureBaselineStats?: FeatureBaselineStats;
}

/**
 * Calls ai/inference/prediction.py as a subprocess. This is the actual
 * language boundary from spec section 16 (AI MODELS -> PREDICTIONS) —
 * the decision engine never imports Python directly, it only depends
 * on this function returning a `ModelPrediction[]`.
 *
 * Per spec section 23 ("AI model unavailable -> No new trade"), this
 * throws rather than returning an empty/default prediction on any
 * failure — callers must treat a rejected promise here as "no
 * prediction available," never silently proceed.
 */
export async function getPythonModelPrediction(
  stage: "development" | "staging" | "production",
  symbol: string,
  timeframe: string,
  featureRow: Record<string, number>,
  mode: "single" | "ensemble" | "hybrid" = "ensemble",
  timeoutMs: number = env.pythonPredictionTimeoutMs
): Promise<MlModelPrediction> {
  const repoRoot = path.resolve(__dirname, "../../../");

  return new Promise((resolve, reject) => {
    const pythonCommand = env.pythonCommand;
    const pythonArgs = process.platform === "win32" && pythonCommand === "py"
      ? ["-3", "-m", "ai.inference.prediction", stage, symbol, timeframe, mode]
      : ["-m", "ai.inference.prediction", stage, symbol, timeframe, mode];
    // Allow a JavaScript helper as PYTHON_COMMAND for portable diagnostics
    // and tests; Windows cannot spawn a .js file directly as an executable.
    const isNodeScript = /\.(?:c|m)?js$/i.test(pythonCommand);
    const command = isNodeScript ? process.execPath : pythonCommand;
    const args = isNodeScript ? [pythonCommand, ...pythonArgs] : pythonArgs;
    const proc = spawn(command, args, {
      cwd: repoRoot,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    // [FIX-PYTHON-BRIDGE-TIMEOUT] Without this, a hung Python process
    // leaves this promise unresolved forever, freezing the entire trading
    // loop (see the comment on pythonPredictionTimeoutMs in env.ts).
    // SIGKILL, not SIGTERM: this bridge's own contract is "any failure
    // here means no prediction, never a default" — there is nothing an
    // in-process Python handler could do on SIGTERM that changes that
    // outcome, so there is no reason to wait out a grace period.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      reject(new Error(`python prediction process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`python prediction process exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        const featureBaselineStats = isValidFeatureBaselineStats(parsed.featureBaselineStats)
          ? (parsed.featureBaselineStats as FeatureBaselineStats)
          : undefined;
        resolve({
          modelName: parsed.modelName,
          modelVersion: parsed.modelVersion,
          action: parsed.action,
          probability: parsed.probability,
          uncertainty: parsed.uncertainty,
          featureBaselineStats,
        });
      } catch (err) {
        reject(new Error(`failed to parse prediction output: ${(err as Error).message}; raw stdout: ${stdout}`));
      }
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.stdin.write(JSON.stringify(featureRow));
    proc.stdin.end();
  });
}

function isValidFeatureBaselineStats(value: unknown): value is FeatureBaselineStats {
  if (value === null || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(
    (stat) =>
      typeof stat === "object" &&
      stat !== null &&
      Number.isFinite((stat as { mean?: unknown }).mean) &&
      Number.isFinite((stat as { std?: unknown }).std)
  );
}
