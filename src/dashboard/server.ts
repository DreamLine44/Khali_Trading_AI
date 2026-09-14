import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { env } from "../config/env";

const publicDir = path.join(__dirname, "public");
const statusPath = env.runtimeStatusFile;

/**
 * Factory rather than an import-time side effect: previously this
 * module called server.listen() at module scope, which meant merely
 * importing it (e.g. from a test) started a real network listener.
 * Exporting a factory lets tests exercise the request handler directly
 * over real HTTP on an ephemeral port instead.
 */
export function createDashboardServer(
  options: { publicDirectory?: string; statusFilePath?: string } = {},
): http.Server {
  const resolvedPublicDir = options.publicDirectory ?? publicDir;
  const resolvedStatusPath = options.statusFilePath ?? statusPath;
  // A trailing separator is appended once, up front, so the traversal
  // check below is a true "starts with this directory" test rather than
  // a bare string-prefix test. Without the separator, `startsWith` also
  // matches a sibling directory whose name happens to share the prefix
  // (e.g. resolvedPublicDir="/app/public" would wrongly admit
  // "/app/public-secret/...").
  const publicDirWithSep = resolvedPublicDir.endsWith(path.sep) ? resolvedPublicDir : resolvedPublicDir + path.sep;

  return http.createServer((req, res) => {
    if (req.url === "/api/status") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      if (fs.existsSync(resolvedStatusPath)) res.end(fs.readFileSync(resolvedStatusPath));
      else res.end(JSON.stringify({ mode: env.tradingMode, healthy: false, message: "No trading cycle has been recorded yet" }));
      return;
    }
    const requestedPath = req.url === "/" ? "index.html" : (req.url ?? "/").replace(/^\//, "");
    const file = path.normalize(path.join(resolvedPublicDir, requestedPath));
    // isFile() (not just existsSync) is required before readFileSync:
    // a request path resolving to an existing directory under public/
    // used to reach fs.readFileSync(directory), which throws EISDIR
    // synchronously outside any try/catch and crashed the whole
    // dashboard process on a single malformed/probing request.
    let isFile = false;
    try {
      isFile = fs.statSync(file).isFile();
    } catch {
      isFile = false;
    }
    if (!file.startsWith(publicDirWithSep) || !isFile) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(file));
  });
}

/* istanbul ignore next -- exercised via tests/unit/dashboard-server.test.ts, not this entry point */
if (require.main === module) {
  const port = env.dashboardPort;
  const server = createDashboardServer();
  server.listen(port, "127.0.0.1", () => console.log(`Dashboard: http://127.0.0.1:${port}`));
}
