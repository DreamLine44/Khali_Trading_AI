import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { createDashboardServer } from "../../src/dashboard/server";

// [FIX-DASHBOARD-SERVER] Regression coverage for two latent bugs found in
// this audit pass:
//  1. A request resolving to an existing directory under public/ called
//     fs.readFileSync() on that directory, which throws EISDIR
//     synchronously with no try/catch — crashing the entire dashboard
//     process on a single malformed/probing request.
//  2. The path-traversal guard used a bare `startsWith(publicDir)` with no
//     trailing separator, so a sibling directory whose name happens to
//     share the publicDir's name as a prefix (e.g. "public-secret" next to
//     "public") could be reached.
// The server previously started a real listener as an import-time side
// effect, so it had no test coverage at all; createDashboardServer() is a
// factory specifically so these can be exercised over real HTTP.

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else throw new Error("failed to bind ephemeral port");
    });
  });
}

function get(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}

async function testDirectoryRequestReturns404NotEISDIRCrash(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-test-"));
  const publicDir = path.join(tmpRoot, "public");
  fs.mkdirSync(path.join(publicDir, "somedir"), { recursive: true });
  fs.writeFileSync(path.join(publicDir, "index.html"), "<html></html>");

  const server = createDashboardServer({ publicDirectory: publicDir, statusFilePath: path.join(tmpRoot, "status.json") });
  const port = await listen(server);
  try {
    // Previously: fs.readFileSync(directory) throws EISDIR synchronously,
    // uncaught, which would crash the whole process (not just return an
    // error response) — so simply getting a response at all, with a 404,
    // is the regression check.
    const res = await get(port, "/somedir");
    assert.strictEqual(res.status, 404, "a directory request must return 404, not crash the process");
  } finally {
    server.close();
  }
  console.log("PASS: testDirectoryRequestReturns404NotEISDIRCrash");
}

async function testSiblingDirectorySharingPublicDirPrefixIsNotReachable(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-test-"));
  const publicDir = path.join(tmpRoot, "public");
  const secretDir = path.join(tmpRoot, "public-secret");
  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(secretDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, "index.html"), "<html></html>");
  fs.writeFileSync(path.join(secretDir, "leaked.txt"), "should never be served");

  const server = createDashboardServer({ publicDirectory: publicDir, statusFilePath: path.join(tmpRoot, "status.json") });
  const port = await listen(server);
  try {
    // A bare startsWith(publicDir) (no trailing separator) would let
    // ".. /public-secret/leaked.txt"-style paths resolving into the
    // sibling directory through unchecked prefix matching. Confirm the
    // guard actually blocks the sibling directory.
    const res = await get(port, "/../public-secret/leaked.txt");
    assert.notStrictEqual(res.body, "should never be served", "sibling directory content must never be served");
    assert.strictEqual(res.status, 404);
  } finally {
    server.close();
  }
  console.log("PASS: testSiblingDirectorySharingPublicDirPrefixIsNotReachable");
}

async function testValidFileIsServed(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-test-"));
  const publicDir = path.join(tmpRoot, "public");
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, "index.html"), "<html>hello</html>");

  const server = createDashboardServer({ publicDirectory: publicDir, statusFilePath: path.join(tmpRoot, "status.json") });
  const port = await listen(server);
  try {
    const res = await get(port, "/");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, "<html>hello</html>");
  } finally {
    server.close();
  }
  console.log("PASS: testValidFileIsServed");
}

async function testMissingStatusFileReturnsHonestPlaceholder(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-test-"));
  const publicDir = path.join(tmpRoot, "public");
  fs.mkdirSync(publicDir, { recursive: true });

  const server = createDashboardServer({ publicDirectory: publicDir, statusFilePath: path.join(tmpRoot, "status.json") });
  const port = await listen(server);
  try {
    const res = await get(port, "/api/status");
    assert.strictEqual(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.healthy, false);
  } finally {
    server.close();
  }
  console.log("PASS: testMissingStatusFileReturnsHonestPlaceholder");
}

async function testExistingStatusFileIsServedVerbatim(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-test-"));
  const publicDir = path.join(tmpRoot, "public");
  fs.mkdirSync(publicDir, { recursive: true });
  const statusFilePath = path.join(tmpRoot, "status.json");
  fs.writeFileSync(statusFilePath, JSON.stringify({ healthy: true, action: "HOLD" }));

  const server = createDashboardServer({ publicDirectory: publicDir, statusFilePath });
  const port = await listen(server);
  try {
    const res = await get(port, "/api/status");
    assert.deepStrictEqual(JSON.parse(res.body), { healthy: true, action: "HOLD" });
  } finally {
    server.close();
  }
  console.log("PASS: testExistingStatusFileIsServedVerbatim");
}

async function testNonexistentFileReturns404(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-test-"));
  const publicDir = path.join(tmpRoot, "public");
  fs.mkdirSync(publicDir, { recursive: true });

  const server = createDashboardServer({ publicDirectory: publicDir, statusFilePath: path.join(tmpRoot, "status.json") });
  const port = await listen(server);
  try {
    const res = await get(port, "/does-not-exist.html");
    assert.strictEqual(res.status, 404);
  } finally {
    server.close();
  }
  console.log("PASS: testNonexistentFileReturns404");
}

async function main(): Promise<void> {
  await testDirectoryRequestReturns404NotEISDIRCrash();
  await testSiblingDirectorySharingPublicDirPrefixIsNotReachable();
  await testValidFileIsServed();
  await testMissingStatusFileReturnsHonestPlaceholder();
  await testExistingStatusFileIsServedVerbatim();
  await testNonexistentFileReturns404();
  console.log("\nAll dashboard server tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
