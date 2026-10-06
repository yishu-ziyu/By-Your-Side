/**
 * 插话里的「记住…」能改记忆（2026-10-06 日常记录：插话「记住这是我常用邮箱」被拒「当前记忆操作已失效，未获授权」）。
 * 只装扩展的无头 Chrome、真侧栏、本机脚本模型：任务跑着时在输入框插一句「记住我的邮箱…」，
 * 脚本模型随后调用 user_memory change。读扩展自己的诊断记录，看这次调用有没有被以「未获授权」拒绝。
 *
 *   npx tsx scripts/probes/memory/steer-remember.mts --headless
 */
import { createServer } from "node:http";
import { launchRealPath, requireHeadless, siteAddress, sleep, until } from "../../acceptance/real-path/harness.mts";
import { startScriptedModel } from "../../acceptance/real-path/scripted-model.mts";

requireHeadless();

const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end("<!doctype html><meta charset=\"utf-8\"><title>播客</title><button>Follow Show</button>"));

await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));

const model = await startScriptedModel([
  { match: "看页甲", steps: [{ tool: { name: "snapshot", args: {} }, delayMs: 5000 }, { text: "页面有一个 Follow Show 按钮。" }] },
  { match: "记住我的邮箱", steps: [{ tool: { name: "user_memory", args: { action: "change" } } }, { text: "好的。" }] },
]);

const failures: string[] = [];

/** evidence 是已序列化的 JSON 文本：探针只打印，不再解析。 */
const check = (name: string, ok: boolean, evidence: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${evidence}`);

  if (!ok) failures.push(name);
};

/** 诊断记录里 user_memory 的调用结果（扩展自己的 IndexedDB，页面脚本读）。 */
const MEMORY_RESULTS = `(async () => {
  const db = await new Promise((r, j) => { const q = indexedDB.open("sideagent-diagnostics"); q.onsuccess = () => r(q.result); q.onerror = j; });
  const lines = await new Promise((r) => { const q = db.transaction("trace-lines").objectStore("trace-lines").getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return lines.map((l) => JSON.parse(l.line)).filter((e) => e.type === "tool_execution_end" && e.data.toolName === "user_memory").map((e) => ({ isError: e.data.isError, text: e.data.result?.content?.[0]?.text ?? "" }));
})()`;

const rp = await launchRealPath();

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, "document.querySelector(\"#send-btn\")?.disabled===false") || undefined, 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  await rp.click(panel, "#input");
  await rp.typeText(panel, "看页甲：这页有什么");
  await rp.pressEnter(panel);
  await sleep(1500);
  await rp.click(panel, "#input");
  await rp.typeText(panel, "记住我的邮箱是 steer.probe@example.test，下次登录用它");
  await rp.pressEnter(panel);

  const results = await until(async () => {
    const r = await rp.evaluate(panel, MEMORY_RESULTS);

    return r.length ? r : undefined;
  }, 60_000, "记忆工具被调用");

  check("插话里的「记住」没有被以「未获授权」拒绝", !results.some((r: { text: string }) => r.text.includes("未获授权")), JSON.stringify(results));
} finally {
  console.log(failures.length ? `FAILED ${failures.length}` : "ALL PASS");
  await rp.close().catch(() => undefined);
  await model.close();
  site.closeAllConnections();
  site.close();
}
