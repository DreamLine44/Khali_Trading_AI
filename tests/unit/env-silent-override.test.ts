import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// [FIX-ENV-SILENT-OVERRIDE] Regression coverage: when a variable is already
// set in the real shell/system environment, env.ts's dotenv loading
// (override: false, by design) means the .env file's value for that same
// key is silently ignored. That's correct precedence, but it was previously
// invisible — this reproduced as exactly the bug a user hit in practice:
// TRADING_MODE=dev left over in a Windows session shadowed a
// .env.development.local that clearly said TRADING_MODE=paper, producing a
// confusing downstream error that looked like a bad .env file. This test
// simulates that shadowing and asserts env.ts now warns about it by name.

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "env-override-test-"));
fs.writeFileSync(path.join(tmpRoot, ".env.test.local"), "TRADING_MODE=paper\n");

process.env.APP_ROOT = tmpRoot;
process.env.NODE_ENV = "test";
// Simulates a stale shell/system variable set before this process started —
// exactly what a leftover `$env:TRADING_MODE = "dev"` in PowerShell does.
process.env.TRADING_MODE = "dev";

const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(" "));
};

async function testShadowedFileValueWarnsWithVariableNameAndBothValues() {
  try {
    // Imported after env vars are set so env.ts's module-level dotenv load
    // (which runs once, at import time) observes this exact scenario.
    require("../../src/config/env");
  } finally {
    console.warn = originalWarn;
  }
  const relevant = warnings.filter((w) => w.includes("TRADING_MODE"));
  assert.ok(relevant.length >= 1, `expected a warning naming TRADING_MODE, got: ${JSON.stringify(warnings)}`);
  const warning = relevant[0] as string;
  assert.ok(warning.includes("dev"), `warning should include the shell's value (dev): ${warning}`);
  assert.ok(warning.includes("paper"), `warning should include the shadowed file value (paper): ${warning}`);
  console.log("PASS: testShadowedFileValueWarnsWithVariableNameAndBothValues");
}

async function main() {
  try {
    await testShadowedFileValueWarnsWithVariableNameAndBothValues();
    console.log("All env silent-override regression tests passed.");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main();
