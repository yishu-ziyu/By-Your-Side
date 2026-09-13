#!/usr/bin/env node
// 本地静态服务：只服务 scripts/fixtures/feature-journeys.html，无依赖、无外部请求。
// 启动：node scripts/fixtures/feature-journeys-server.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.FIXTURE_PORT || 48765);
const PAGE = fileURLToPath(new URL("./feature-journeys.html", import.meta.url));

export function createFixtureServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }

    if (url.pathname !== "/" && url.pathname !== "/feature-journeys.html") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("404 - 只有 / 与 /feature-journeys.html 可用\n");
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
      res.end("405 - 只读模拟页面\n");
      return;
    }

    try {
      const html = await readFile(PAGE);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": String(html.byteLength)
      });
      res.end(req.method === "HEAD" ? undefined : html);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`500 - 无法读取页面: ${error.message}\n`);
    }
  });
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  const server = createFixtureServer();
  server.listen(PORT, HOST, () => {
    console.log("模拟测试页面已启动（仅本地回环，不会打开浏览器）:");
    console.log(`  http://${HOST}:${PORT}/`);
    console.log(`  场景 A: http://${HOST}:${PORT}/?scenario=a`);
    console.log(`  场景 B: http://${HOST}:${PORT}/?scenario=b`);
    console.log("启动命令: node scripts/fixtures/feature-journeys-server.mjs");
    console.log("停止: Ctrl+C");
  });
  server.on("error", (error) => {
    console.error(`无法绑定 ${HOST}:${PORT} - ${error.message}`);
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
