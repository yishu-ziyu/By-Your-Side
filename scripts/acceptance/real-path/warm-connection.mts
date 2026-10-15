/**
 * 提前建连接：用户点进输入框、想几秒再发，这几秒里后台先连上模型服务，发出去的第一个模型请求直接用这条连接，不再等建连接。
 * 真实模型，只装扩展，无头；在后台文档（inproc.html）上开网络记录，只记请求头的名字，不记值。
 *   SIDEAGENT_ACCEPTANCE_DIST=<dist> NODE_OPTIONS=--conditions=import npx tsx scripts/acceptance/real-path/warm-connection.mts --headless [--model=provider/id]
 * 失败方式：点进输入框后、按回车前没有发往模型服务的 HEAD；HEAD 带了 authorization、cookie 或 chatgpt-account-id；模型请求带上了用户在该网站的 cookie；
 * 第一个模型请求没复用连接，或浏览器计时里还有建连接、握手阶段；面板里没出现回答；30 秒内再点进输入框又发了一次 HEAD。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until, type JsonRecord, type TargetInfo } from "./harness.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL;
const plan = await loadModelPlan(modelArg);
const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-warm-connection`);

await mkdir(artifacts, { recursive: true });

const MODEL_POST = /^https:\/\/[^/]+\/backend-api\/codex\/responses(\?|$)/;
const SECRET = ["authorization", "cookie", "chatgpt-account-id"];
const WINDOW_MS = 30_000;

interface Seen {
  method: string; url: string; wallStartMs: number;
  /** 只留名字：请求头的值可能是凭据。 */
  headerNames: Set<string>;
  connectionReused?: boolean; connectionId?: number; protocol?: string; status?: number; failed?: string;
  timing?: { connectStart: number; connectEnd: number; sslStart: number; sslEnd: number; dnsStart: number };
}

const rp = await launchRealPath();
// 代表用户登录 chatgpt.com 网页版后浏览器里会有的 cookie：模型请求不应带上它（默认测试模型走 chatgpt.com）。
await rp.cdp.send("Storage.setCookies", { cookies: [{ name: "probe_session", value: "fake", domain: ".chatgpt.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }] });
const requests = new Map<string, Seen>();
const sessions = new Set<string>();
const evidence: JsonRecord = { model: modelArg, dist: process.env.SIDEAGENT_ACCEPTANCE_DIST ?? null };
let error: string | null = null;
let panel = "";

const on = <P,>(method: string, fn: (p: P) => void) => rp.cdp.onEvent(method, (m: { sessionId?: string; params: P }) => {
  if (m.sessionId && sessions.has(m.sessionId)) fn(m.params);
});
const names = (headers: Record<string, string> | undefined) => Object.keys(headers ?? {}).map((name) => name.toLowerCase());

on<{ requestId: string; wallTime: number; request: { url: string; method: string; headers: Record<string, string> } }>("Network.requestWillBeSent", (p) => {
  const seen = requests.get(p.requestId);
  const entry: Seen = { method: p.request.method, url: p.request.url, wallStartMs: p.wallTime * 1000, headerNames: new Set([...(seen?.headerNames ?? []), ...names(p.request.headers)]) };
  requests.set(p.requestId, entry);
});
// 浏览器真正发出去的请求头（含 cookie）只在这里出现，可能比 requestWillBeSent 早到。
on<{ requestId: string; headers: Record<string, string> }>("Network.requestWillBeSentExtraInfo", (p) => {
  const entry = requests.get(p.requestId);

  if (entry) for (const name of names(p.headers)) entry.headerNames.add(name);
  else requests.set(p.requestId, { method: "", url: "", wallStartMs: 0, headerNames: new Set(names(p.headers)) });
});
on<{ requestId: string; response: { status: number; connectionReused: boolean; connectionId: number; protocol?: string; timing?: Seen["timing"] } }>("Network.responseReceived", (p) => {
  const entry = requests.get(p.requestId);

  if (entry) Object.assign(entry, { status: p.response.status, connectionReused: p.response.connectionReused, connectionId: p.response.connectionId, protocol: p.response.protocol, timing: p.response.timing });
});
on<{ requestId: string; errorText: string }>("Network.loadingFailed", (p) => { const entry = requests.get(p.requestId); if (entry) entry.failed = p.errorText; });

const inprocUrl = `chrome-extension://${rp.extensionId}/inproc.html`;
const attachInproc = async (target: TargetInfo) => {
  const session = await rp.attach(target.targetId);
  sessions.add(session);
  await rp.cdp.send("Network.enable", {}, session);
};

// 后台文档可能被重建，新的也要接上。
rp.cdp.onEvent("Target.targetCreated", (m: { params: { targetInfo: TargetInfo } }) => {
  if (m.params.targetInfo.url === inprocUrl) attachInproc(m.params.targetInfo).catch(() => undefined);
});

const idle = `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")`;

try {
  await rp.cdp.send("Target.setDiscoverTargets", { discover: true });
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "工作标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: "https://example.com" }, work);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  await attachInproc(await until(async () => (await rp.targets()).find((t) => t.url === inprocUrl), 30_000, "后台文档"));
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
  await until(async () => (await rp.evaluate(work, `document.readyState === "complete"`)) || undefined, 30_000, "起始页加载完");
  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });
  await sleep(3000);

  // 用户点进输入框，想 3 秒；中途移开再点回来一次（30 秒内不该再发 HEAD）。
  const focusMs = Date.now();
  await rp.click(panel, "#input");
  await sleep(3000);
  await rp.evaluate(panel, `(document.querySelector("#input").blur(), true)`);
  await sleep(300);
  await rp.click(panel, "#input");
  await sleep(500);
  const userMsgs = `document.querySelectorAll("#messages .msg.user").length`;
  const count0 = Number(await rp.evaluate(panel, userMsgs));
  await rp.typeText(panel, "这页标题是什么？一句话回答。");
  const enterMs = Date.now();
  await rp.pressEnter(panel);
  await until(async () => Number(await rp.evaluate(panel, userMsgs)) > count0 || undefined, 15_000, "问题发出");
  await sleep(1500);
  await until(async () => (await rp.evaluate(panel, idle)) || undefined, 180_000, "回答完", 500);
  const answer = String(await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant")].filter((x) => !x.closest(".run-steps")).at(-1)?.innerText ?? ""`));
  await rp.screenshot(panel, join(artifacts, "panel.png"));

  const all = [...requests.values()].filter((r) => r.url).sort((a, b) => a.wallStartMs - b.wallStartMs);
  const post = all.find((r) => r.method === "POST" && MODEL_POST.test(r.url));
  const origin = post ? new URL(post.url).origin : null;
  const heads = all.filter((r) => r.method === "HEAD" && origin && new URL(r.url).origin === origin);
  const head = heads[0];
  const view = (r: Seen | undefined) => r && { method: r.method, url: r.url.replace(/\?.*$/, ""), sinceFocusMs: Math.round(r.wallStartMs - focusMs), sinceEnterMs: Math.round(r.wallStartMs - enterMs), headerNames: [...r.headerNames].sort(), status: r.status ?? null, failed: r.failed ?? null, protocol: r.protocol ?? null, connectionReused: r.connectionReused ?? null, connectionId: r.connectionId ?? null, timing: r.timing ? { dnsStart: r.timing.dnsStart, connectStart: r.timing.connectStart, connectEnd: r.timing.connectEnd, sslStart: r.timing.sslStart, sslEnd: r.timing.sslEnd } : null };

  Object.assign(evidence, {
    answer: answer.slice(0, 300),
    head: view(head) ?? null,
    firstModelPost: view(post) ?? null,
    postUsesHeadConnection: head?.connectionId !== undefined && head.connectionId === post?.connectionId,
    headsWithin30s: head ? heads.filter((r) => r.wallStartMs - head.wallStartMs < WINDOW_MS).length : 0,
    modelOriginRequestsBeforeFocus: origin ? all.filter((r) => r.wallStartMs < focusMs && new URL(r.url).origin === origin).map((r) => `${r.method} ${r.url.replace(/\?.*$/, "")}`) : [],
  });

  assert.ok(post, "有发往模型服务的 POST /backend-api/codex/responses");
  assert.ok(head, `点进输入框后有发往 ${origin} 的 HEAD`);
  assert.ok(head.wallStartMs >= focusMs && head.wallStartMs < enterMs, `HEAD 在点进输入框之后、按回车之前发出：${JSON.stringify(evidence.head)}`);
  assert.deepEqual(SECRET.filter((name) => head.headerNames.has(name)), [], "HEAD 不带凭据请求头");
  assert.ok(!post.headerNames.has("cookie"), "模型请求不带浏览器里这个网站的 cookie（测试浏览器里事先放了一个）");
  assert.equal(post.connectionReused, true, `第一个模型请求复用了连接：${JSON.stringify(evidence.firstModelPost)}`);
  assert.ok(post.timing && post.timing.connectStart === -1 && post.timing.sslStart === -1, `第一个模型请求没有建连接和握手阶段：${JSON.stringify(evidence.firstModelPost)}`);
  assert.ok(answer.trim().length > 0, "面板里出现回答");
  assert.equal(evidence.headsWithin30s, 1, "30 秒内再点进输入框不再发 HEAD");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (panel) await rp.screenshot(panel, join(artifacts, "failure-panel.png")).catch(() => undefined);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
process.exit();
