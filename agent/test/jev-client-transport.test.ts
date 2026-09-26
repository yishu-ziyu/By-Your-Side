import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import { askJev, type JevTrace } from "../src/jev-client.js";

// Real undici transport against local servers. Ways this could fail:
// 1. a connection dropped before any response is not retried, so a recoverable request fails;
// 2. a request the server already received is sent again after a response timeout (not connection level);
// 3. an HTTP error status is retried;
// 4. a stalled TLS handshake burns the whole 3 s budget instead of failing fast and retrying once;
// 5. more than one retry;
// 6. the API key reaches a trace;
// 7. the connection is not kept between loop steps more than 4 s apart (undici's default idle limit).
const KEY = "secret-transport-test-key";

const servers: Array<Server | ReturnType<typeof createTcpServer>> = [];

afterEach(async () => {
  delete process.env.TYPESAFE_API_KEY;
  await Promise.all(servers.splice(0).map(s => new Promise(r => s.close(() => r(null)))));
});

const request = { state: { request: { task: "fixture" } }, questions: { q: { type: "noul", instructions: "Is it?" } } };

async function listen(server: Server | ReturnType<typeof createTcpServer>) {
  servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));

  return (server.address() as { port: number }).port;
}

function jsonServer(handle: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, n: number) => void) {
  let requests = 0;
  const sockets = new Set<Socket>();
  const server = createHttpServer((req, res) => { req.resume(); req.on("end", () => handle(req, res, ++requests)); });
  server.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  const closeAll = () => { for (const s of sockets) s.destroy(); };

  servers.push({ close: (cb: () => void) => { closeAll(); server.close(cb); } } as never);

  return { server, requests: () => requests, closeAll };
}

it("retries once when the connection drops before a response, and recovers", async () => {
  process.env.TYPESAFE_API_KEY = KEY;

  const s = jsonServer((req, res, n) => {
    if (n === 1) { req.socket.destroy();

 return; }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ answers: { q: { noul: 0.9 } } }));
  });

  const port = await new Promise<number>(r => s.server.listen(0, "127.0.0.1", () => r((s.server.address() as { port: number }).port)));
  const traces: JevTrace[] = [];

  const answers = await askJev(request, new AbortController().signal, { endpoint: `http://127.0.0.1:${port}/`, onTrace: e => traces.push(e) });

  expect(answers.q?.noul).toBe(0.9);
  expect(s.requests()).toBe(2);
  expect(traces.map(t => t.phase)).toEqual(["request", "retry", "response"]);
  expect(traces.at(-1)).toMatchObject({ attempts: 2 });
  expect(JSON.stringify(traces)).not.toContain(KEY);
});

it("does not resend a request the server received when its response times out", async () => {
  process.env.TYPESAFE_API_KEY = KEY;
  const s = jsonServer(() => { /* never answers */ });
  const port = await new Promise<number>(r => s.server.listen(0, "127.0.0.1", () => r((s.server.address() as { port: number }).port)));
  const traces: JevTrace[] = [];
  const started = Date.now();

  await expect(askJev(request, new AbortController().signal, { endpoint: `http://127.0.0.1:${port}/`, onTrace: e => traces.push(e) })).rejects.toThrow();

  expect(Date.now() - started).toBeLessThan(3600);
  expect(s.requests()).toBe(1);
  expect(traces.map(t => t.phase)).toEqual(["request", "error"]);
  expect(traces.at(-1)).toMatchObject({ connection: false, attempts: 1 });
  s.closeAll();
}, 10_000);

it("does not retry an HTTP error status", async () => {
  process.env.TYPESAFE_API_KEY = KEY;
  const s = jsonServer((_req, res) => { res.writeHead(500); res.end("no"); });
  const port = await new Promise<number>(r => s.server.listen(0, "127.0.0.1", () => r((s.server.address() as { port: number }).port)));

  await expect(askJev(request, new AbortController().signal, { endpoint: `http://127.0.0.1:${port}/` })).rejects.toThrow("Jev HTTP 500");
  expect(s.requests()).toBe(1);
});

it("a stalled TLS handshake fails fast and is retried exactly once inside the 3 s budget", async () => {
  process.env.TYPESAFE_API_KEY = KEY;
  let connections = 0;
  const held: Socket[] = [];
  const tcp = createTcpServer(socket => { connections++; held.push(socket); /* accepts, never speaks TLS */ });
  const port = await listen(tcp);
  const traces: JevTrace[] = [];
  const started = Date.now();

  await expect(askJev(request, new AbortController().signal, { endpoint: `https://127.0.0.1:${port}/`, onTrace: e => traces.push(e) })).rejects.toThrow();

  const elapsed = Date.now() - started;

  for (const s of held) s.destroy();
  expect(connections).toBe(2);
  expect(elapsed).toBeLessThan(3200);
  expect(traces.map(t => t.phase)).toEqual(["request", "retry", "error"]);
  expect(traces.at(-1)).toMatchObject({ connection: true, attempts: 2 });
}, 10_000);

it("keeps one connection across requests 4.5 s apart", async () => {
  process.env.TYPESAFE_API_KEY = KEY;
  let connections = 0;
  const s = jsonServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ answers: {} })); });
  s.server.keepAliveTimeout = 60_000;
  s.server.on("connection", () => { connections++; });
  const port = await new Promise<number>(r => s.server.listen(0, "127.0.0.1", () => r((s.server.address() as { port: number }).port)));
  const endpoint = `http://127.0.0.1:${port}/`;

  await askJev(request, new AbortController().signal, { endpoint });
  await new Promise(r => setTimeout(r, 4500));
  await askJev(request, new AbortController().signal, { endpoint });

  expect(s.requests()).toBe(2);
  expect(connections).toBe(1);
  s.closeAll();
}, 15_000);

it("the opt-in trace carries the exact request; a broken observer cannot change the answers", async () => {
  process.env.TYPESAFE_API_KEY = KEY;
  let transmitted = "";

  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => { transmitted = body; res.writeHead(200, { "content-type": "application/json", "x-request-id": "fixture-request" }); res.end(JSON.stringify({ answers: { q: { choice: "b", confidence: 0.9 } } })); });
  });

  const port = await listen(server);
  const traces: JevTrace[] = [];

  const answers = await askJev(request, new AbortController().signal, { endpoint: `http://127.0.0.1:${port}/`, onTrace: e => {
    traces.push(e);

    if (e.phase === "response") { (e.data as { answers: { q: { choice: string } } }).answers.q.choice = "a"; throw new Error("observer bug"); }
  } });

  expect(answers.q?.choice).toBe("b");
  expect(traces[0]).toMatchObject({ phase: "request", body: transmitted, bytes: Buffer.byteLength(transmitted), sha256: createHash("sha256").update(transmitted).digest("hex") });
  expect(traces.at(-1)).toMatchObject({ phase: "response", requestId: "fixture-request" });
  expect(JSON.stringify(traces)).not.toContain(KEY);
});
