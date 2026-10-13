/**
 * F01：没连模型时发出的话，连好后看得见它发出去；密钥无效时设置页不标红。
 * npx tsx scripts/acceptance/real-path/connect-first-minute.mts --headless
 * 验收：docs/evals/20261012-connect-first-minute.md
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

type RealPath = Awaited<ReturnType<typeof launchRealPath>>;

const QUESTION = "概括当前页";
const EARLIER = "先看看这页讲什么";
const ANSWER = "这是周报页，三件事都列在上面。";
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-connect-first-minute`);
await mkdir(out, { recursive: true });

const results: Array<[string, boolean, unknown?]> = [];
const check = (name: string, pass: boolean, detail?: unknown) => { results.push([name, pass, detail]); };
let error: string | null = null;

const busy = createServer((_req, res) => {
  res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Rate limit reached", type: "rate_limit" } }));
});
await new Promise<void>((done) => busy.listen(0, "127.0.0.1", done));
const busyUrl = `http://127.0.0.1:${siteAddress(busy).port}/v1`;

const deny = createServer((_req, res) => {
  res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Invalid API key", type: "unauthorized" } }));
});
await new Promise<void>((done) => deny.listen(0, "127.0.0.1", done));
const denyUrl = `http://127.0.0.1:${siteAddress(deny).port}/v1`;

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end("<title>周报 · 团队空间</title><h1>周报 · 团队空间</h1><p>发布、风险、待办。</p>");
});
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${siteAddress(site).port}/`;

const EARLIER_ANSWER = "这页先看过了。";
const model = await startScriptedModel([
  { match: QUESTION, steps: [{ text: ANSWER, chunkDelayMs: 20 }] },
  { match: EARLIER, steps: [{ text: EARLIER_ANSWER, chunkDelayMs: 20 }] },
]);
const asked = () => model.requests.filter((r) => r.rule === QUESTION && r.tools).length;
/** 所有主任务请求（带工具），不管匹不匹配脚本：连发两句时 EARLIER 被自动发出也算得到。 */
const mainRequests = () => model.requests.filter((r) => r.tools).length;

const viewSrc = `(() => ({
  held: !!document.querySelector('[data-f01="held"]'),
  hint: document.querySelector(".held-hint")?.textContent ?? "",
  unconnected: [...document.querySelectorAll(".needs-model-card:not(.needs-model-connected):not(.needs-model-dropped)")].length > 0,
  dropped: document.querySelector(".needs-model-dropped")?.innerText ?? "",
  pill: document.querySelector('[data-f01="pill"]')?.textContent?.trim() ?? "",
  heldPending: !!document.querySelector(".held-pending"),
  users: [...document.querySelectorAll(".msg.user")].map((b) => (b.querySelector(".user-msg-text")?.textContent ?? b.textContent).trim()),
  text: document.querySelector("#messages")?.innerText ?? "",
  morph: window.__f01?.morph ?? null,
  flip: window.__f01?.flip ?? null,
}))()`;

const watchSrc = `(() => {
  window.__f01 = { morph: null, flip: null };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.name === "f01-morph") window.__f01.morph = e.duration;
      if (e.name === "f01-flip") window.__f01.flip = e.duration;
    }
  }).observe({ type: "measure", buffered: true });
  return true;
})()`;

type PanelView = { dropped: string; held: boolean; hint: string; unconnected: boolean; pill: string; heldPending: boolean; users: string[]; text: string; morph: number | null; flip: number | null };

const readView = (rp: RealPath, panel: string) => rp.evaluate(panel, viewSrc) as Promise<PanelView>;

const formOpenSrc = `!!document.querySelector("#provider-form") && !document.querySelector("#provider-form").hidden`;

async function fillCustom(rp: RealPath, page: string, baseUrl: string, key: string): Promise<void> {
  await until(async () => (await rp.evaluate(page, `document.querySelectorAll(".provider-option").length`)) > 3 || undefined, 15_000, "设置页服务商");
  if (!await rp.evaluate(page, formOpenSrc)) {
    await rp.evaluate(page, `(() => { const more = document.querySelector("#provider-more"); if (more) more.open = true; return true; })()`);
    await rp.click(page, `.provider-option[data-provider="custom"]`);
    await until(async () => await rp.evaluate(page, formOpenSrc) || undefined, 5_000, "自定义表单");
  }
  for (const [id, value] of [["#base-url", baseUrl], ["#api-key", key], ["#model-id", "fixture"]] as const) {
    await rp.evaluate(page, `document.querySelector(${JSON.stringify(id)}).scrollIntoView({ block: "center" }); true`);
    await rp.click(page, id);
    await rp.evaluate(page, `document.querySelector(${JSON.stringify(id)}).select?.()`);
    await rp.typeText(page, value);
  }
}

async function openFreshPanel(rp: RealPath, reduced = false): Promise<string> {
  const tab = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "网页标签");
  await rp.cdp.send("Page.navigate", { url: pageUrl }, await rp.attach(tab.targetId));
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  if (reduced) await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, panel);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled === false') || undefined, 30_000, "会话就绪");

  return panel;
}

async function sendHeld(rp: RealPath, panel: string, text = QUESTION): Promise<PanelView> {
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);

  return until(async () => { const v = await readView(rp, panel); return v.unconnected && v.users.some((u) => u.startsWith(text)) ? v : undefined; }, 30_000, "未连接卡");
}

async function saveCustom(rp: RealPath, panel: string, baseUrl: string, key: string): Promise<string> {
  await rp.click(panel, ".needs-model-connect");
  const target = await until(async () => (await rp.targets()).find((t) => t.url.endsWith("/settings.html")), 10_000, "设置页");
  const page = await rp.attach(target.targetId);
  await fillCustom(rp, page, baseUrl, key);
  await rp.evaluate(page, `document.querySelector("#model-save").scrollIntoView({ block: "center" }); true`);
  await rp.click(page, "#model-save");

  return page;
}

let rp: RealPath | undefined;
let reduced: RealPath | undefined;
let reducedPanel: string | undefined;
try {
  const first = await launchRealPath();
  rp = first;
  const panel = await openFreshPanel(first);
  const held = await sendHeld(first, panel);
  await first.screenshot(panel, join(out, "01-held.png"));
  check("R1 未连接卡里的话带「连好后自动发」", held.held && held.hint.includes("连好后自动发") && held.users.some((u) => u.startsWith(QUESTION)), held);

  const settings = await saveCustom(first, panel, denyUrl, "sk-invalid-0000");
  const fail = await until(async () => {
    const state = await first.evaluate(settings, `({
      hidden: document.querySelector("#key-reason").hidden,
      reason: document.querySelector("#key-reason-text")?.textContent ?? "",
      wait: document.querySelector(".key-reason-wait")?.textContent ?? "",
      warn: document.querySelector("#api-key").classList.contains("warn"),
      status: document.querySelector("#model-status").textContent ?? "",
      tone: document.querySelector("#model-status").dataset.tone ?? "",
    })`);

    return !state.hidden && state.reason ? state : undefined;
  }, 45_000, "密钥原因");
  await first.screenshot(settings, join(out, "02-invalid-key.png"));
  check("密钥无效：框下一行原因，不写红色「连接失败」", fail.reason.includes("服务商不接受这个密钥") && fail.wait.includes("侧栏里那句话还在等你") && fail.warn && !fail.status.includes("连接失败") && fail.tone !== "err", fail);
  const storedAfterDeny = await first.evaluate(settings, `chrome.storage.local.get("inproc_model_config").then((r) => r.inproc_model_config?.baseUrl ?? null)`);
  check("密钥无效：没有保存，侧栏仍在等", (await readView(first, panel)).unconnected && asked() === 0 && storedAfterDeny !== denyUrl, { storedAfterDeny });

  await first.evaluate(panel, watchSrc);
  await fillCustom(first, settings, model.baseUrl, "local-fixture");
  await first.evaluate(settings, `document.querySelector("#model-save").scrollIntoView({ block: "center" }); true`);
  await first.click(settings, "#model-save");
  await until(async () => String(await first.evaluate(settings, `document.querySelector("#model-status").textContent`)).startsWith("已保存") || undefined, 45_000, "保存成功");
  const answered = await until(async () => { const v = await readView(first, panel); return v.text.includes(ANSWER) && !v.unconnected ? v : undefined; }, 45_000, "自动发出后的回答");
  await sleep(400);
  const after = await readView(first, panel);
  await first.screenshot(panel, join(out, "03-connected.png"));
  check("R2 连好后未连接卡不再出现", !after.unconnected && after.pill.includes("已连上"), after);
  check("R3 原话只发出一次，只有一个用户气泡", asked() === 1 && after.users.length === 1 && after.users[0]!.startsWith(QUESTION) && !!answered, { asked: asked(), users: after.users });
  // 测得的时长只会因为计时和调度变长：下限 -20，上限 +50。
  check("R4 变形 240ms（-20/+50）", after.morph != null && after.morph >= 220 && after.morph <= 290, after.morph);
  check("R4 FLIP 320ms（-20/+50）", after.flip != null && after.flip >= 300 && after.flip <= 370, after.flip);
  await first.close();
  await first.remove();
  rp = undefined;

  const second = await launchRealPath();
  reduced = second;
  const rpanel = await openFreshPanel(second, true);
  reducedPanel = rpanel;
  const requestsBefore = mainRequests();
  // 连模型前连发两句：两句都自动发出。
  const stopTwo = await recordScreen(second.cdp, rpanel, join(out, "two-queued.mp4"));
  await sendHeld(second, rpanel, EARLIER);
  await sendHeld(second, rpanel);
  await second.evaluate(rpanel, watchSrc);
  const rsettings = await saveCustom(second, rpanel, model.baseUrl, "local-fixture");
  await until(async () => String(await second.evaluate(rsettings, `document.querySelector("#model-status").textContent`)).startsWith("已保存") || undefined, 45_000, "减少动效已保存");
  const rdone = await until(async () => { const v = await readView(second, rpanel); return v.text.includes(ANSWER) && v.text.includes(EARLIER_ANSWER) && !v.unconnected ? v : undefined; }, 45_000, "减少动效结束态");
  await second.screenshot(rpanel, join(out, "04-reduced-motion.png"));
  console.log("two-queued.mp4", await stopTwo());
  check("R4 减少动效：直接到结束态，不报变形时长", rdone.pill.includes("已连上") && !rdone.heldPending && rdone.morph == null && rdone.flip == null, rdone);
  check("R2 连发两句：两句都自动发出，不留「这句没有发出」", asked() === 2 && mainRequests() - requestsBefore === 2 && !rdone.hint && !rdone.dropped && rdone.users.length === 2 && rdone.users[0]!.startsWith(EARLIER) && rdone.users[1]!.startsWith(QUESTION), { asked: asked(), mainRequests: mainRequests() - requestsBefore, hint: rdone.hint, dropped: rdone.dropped, users: rdone.users });

  // 先试连再保存：限流不算密钥错，照样保存，并说刚才没连上。
  await fillCustom(second, rsettings, busyUrl, "sk-busy-0000");
  await second.evaluate(rsettings, `document.querySelector("#model-save").scrollIntoView({ block: "center" }); true`);
  await second.click(rsettings, "#model-save");
  const busySaved = await until(async () => {
    const status = String(await second.evaluate(rsettings, `document.querySelector("#model-status").textContent`));
    return status.startsWith("已保存") ? status : undefined;
  }, 45_000, "限流时保存");
  const stored = await second.evaluate(rsettings, `chrome.storage.local.get("inproc_model_config").then((r) => r.inproc_model_config?.baseUrl ?? null)`);
  await second.screenshot(rsettings, join(out, "05-saved-while-busy.png"));
  check("密钥试连：限流时照样保存，并写刚才没连上", busySaved.includes("刚才没连上") && stored === busyUrl, { busySaved, stored });
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  if (reduced && reducedPanel) {
    await reduced.screenshot(reducedPanel, join(out, "fail-reduced.png")).catch(() => {});
    results.push(["失败时的侧栏", false, await readView(reduced, reducedPanel).catch(() => null)]);
  }
} finally {
  await writeFile(join(out, "summary.json"), JSON.stringify({ status: error || results.some(([, pass]) => !pass) ? "FAIL" : "PASS", results, asked: asked(), error }, null, 2));
  if (rp) { await rp.close().catch(() => {}); await rp.remove().catch(() => {}); }
  if (reduced) { await reduced.close().catch(() => {}); await reduced.remove().catch(() => {}); }
  busy.closeAllConnections();
  busy.close();
  deny.closeAllConnections();
  deny.close();
  site.closeAllConnections();
  site.close();
  await model.close();
}

for (const [name, pass, detail] of results) console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : ` ${JSON.stringify(detail)}`}`);
if (error) console.log(`ERROR ${error}`);
console.log(`证据：${out}`);
if (error || results.some(([, pass]) => !pass)) process.exitCode = 1;
