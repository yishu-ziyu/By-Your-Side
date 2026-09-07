import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = dirname(
  fileURLToPath(new URL("../../extension/test/fixtures/observation-integrity.html", import.meta.url)),
);

/**
 * 启动专用于观测与点击完整性验收的 HTTP 夹具服务。
 * 提供双页面：
 * 1. / 或 /observation-integrity.html -> 主工作页 (WORK_PAGE_ALPHA)
 * 2. /other 或 /observation-integrity-other.html -> 干扰/次活动页 (OTHER_PAGE_BETA)
 */
export function startIntegrityFixtureServer() {
  const primaryPath = join(FIXTURE_DIR, "observation-integrity.html");
  const otherPath = join(FIXTURE_DIR, "observation-integrity-other.html");

  const server = createServer((req, res) => {
    const raw = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    let file = null;

    if (raw === "/" || raw === "/index.html" || raw === "/observation-integrity.html") {
      file = primaryPath;
    } else if (raw === "/other" || raw === "/other.html" || raw === "/observation-integrity-other.html") {
      file = otherPath;
    }

    if (!file || !existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found in Integrity Fixture Server");
      return;
    }

    const resolved = normalize(file);
    if (!resolved.startsWith(normalize(FIXTURE_DIR))) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    const { size } = statSync(resolved);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": size,
      "cache-control": "no-store, no-cache, must-revalidate",
    });
    createReadStream(resolved).pipe(res);
  });

  server.keepAliveTimeout = 1;
  server.headersTimeout = 2000;

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Integrity fixture server failed to bind 127.0.0.1"));
        return;
      }
      resolve({
        port: addr.port,
        origin: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((res) => {
            const timer = setTimeout(res, 500);
            try {
              server.closeAllConnections?.();
            } catch {
              /* ignore */
            }
            server.close(() => {
              clearTimeout(timer);
              res();
            });
          }),
      });
    });
    server.on("error", reject);
  });
}
