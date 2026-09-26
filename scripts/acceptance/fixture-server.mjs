import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = dirname(
  fileURLToPath(new URL("../../extension/test/fixtures/acceptance/index.html", import.meta.url)),
);

/** 验收页白名单：默认仍是 index.html；新增能力对齐页按名放行，不开放任意路径。 */
const FIXTURE_FILES = new Set(["index.html", "cursor-visibility.html", "parity.html", "downloads.html"]);

/** downloads.html 上的两个文件：一个完整下完；一个声明 64 KB、发 4 KB 后断开，Chrome 记为下载中断。 */
export const DOWNLOAD_FIXTURES = {
  complete: { path: "/files/quarterly-report.csv", filename: "quarterly-report.csv", body: "quarter,revenue\nQ1,120\nQ2,135\nQ3,150\n" },
  broken: { path: "/files/project-archive.zip", filename: "project-archive.zip", declaredBytes: 65_536, sentBytes: 4096 },
};

function serveDownload(path, res) {
  const { complete, broken } = DOWNLOAD_FIXTURES;

  if (path === complete.path) {
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${complete.filename}"`, "content-length": Buffer.byteLength(complete.body), "cache-control": "no-store" });
    res.end(complete.body);

    return true;
  }

  if (path === broken.path) {
    res.writeHead(200, { "content-type": "application/zip", "content-disposition": `attachment; filename="${broken.filename}"`, "content-length": broken.declaredBytes, "cache-control": "no-store" });
    res.write(Buffer.alloc(broken.sentBytes, 1));
    setTimeout(() => res.destroy(), 300);

    return true;
  }

  return false;
}

export function startFixtureServer() {
  const server = createServer((req, res) => {
    const raw = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");

    if (serveDownload(raw, res)) return;
    const name = raw === "/" ? "/index.html" : raw;
    const file = name.startsWith("/") ? name.slice(1) : name;

    if (!FIXTURE_FILES.has(file)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");

      return;
    }

    const resolved = normalize(join(FIXTURE_DIR, file));

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
