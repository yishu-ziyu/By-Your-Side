import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = dirname(
  fileURLToPath(new URL("../../extension/test/fixtures/acceptance/index.html", import.meta.url)),
);

export function startFixtureServer() {
  const server = createServer((req, res) => {
    const raw = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    const name = raw === "/" ? "/index.html" : raw;
    if (name !== "/index.html") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const file = join(FIXTURE_DIR, "index.html");
    const resolved = normalize(file);
    if (!resolved.startsWith(normalize(FIXTURE_DIR)) || !existsSync(resolved)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const { size } = statSync(resolved);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": size,
      "cache-control": "no-store",
    });
    createReadStream(resolved).pipe(res);
  });

  server.keepAliveTimeout = 1;
  server.headersTimeout = 2000;
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("fixture server 未绑定 127.0.0.1"));
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
              /* Node 旧版本没有 closeAllConnections */
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
