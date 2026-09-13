import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// [FIX-PYTHON-BRIDGE-TIMEOUT] Regression coverage: getPythonModelPrediction()
// must not hang forever when the spawned Python process never exits (a
// stuck model load, a deadlock, an inference script that itself makes a
// blocking network call). Point PYTHON_COMMAND at a script that ignores its
// arguments and just sleeps, standing in for a genuinely hung process.

const hangScript = path.join(os.tmpdir(), `hang-${process.pid}-${Date.now()}.js`);
fs.writeFileSync(hangScript, "setTimeout(() => {}, 60_000);\n");
process.env.PYTHON_COMMAND = hangScript;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

// Imported AFTER setting PYTHON_COMMAND so env.ts (override:false dotenv)
// picks up this value rather than any local .env file.
import { getPythonModelPrediction } from "../../src/core/ai-bridge/python-model-bridge";

async function testHungProcessTimesOutRatherThanHangingForever() {
  const startedAtMs = Date.now();
  await assert.rejects(
    () => getPythonModelPrediction("development", "EURUSD", "M15", { f: 1 }, "ensemble", 300),
    /timed out after 300ms/,
  );
  const elapsedMs = Date.now() - startedAtMs;
  assert.ok(elapsedMs < 5000, `expected the timeout to fire promptly, took ${elapsedMs}ms`);
  console.log("PASS: testHungProcessTimesOutRatherThanHangingForever");
}

async function main() {
  try {
    await testHungProcessTimesOutRatherThanHangingForever();
    console.log("All python-bridge timeout regression tests passed.");
  } finally {
    fs.rmSync(hangScript, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
