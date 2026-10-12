/**
 * F01：没连模型时发出的话，连好后看得见它发出去；密钥无效时设置页不标红。
 * npx tsx scripts/acceptance/real-path/connect-first-minute.mts --headless
 * 验收：docs/evals/20261012-connect-first-minute.md
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

type RealPath = Awaited<ReturnType<typeof launchRealPath>>;

const QUESTION = "概括当前页";
const ANSWER = "这是周报页，三件事都列在上面。";
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-connect-first-minute`);
await mkdir(out, { recursive: true });

const results: Array<[string, boolean, unknown?]> = [];
const check = (name: string, pass: boolean, detail?: unknown) => { results.push([name, pass, detail]); };
let error: string | null = null;

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

const model = await startScriptedModel([{ match: QUESTION, steps: [{ text: ANSWER, chunkDelayMs: 20 }] }]);
const asked = () => model.requests.filter((r) => r.rule === QUESTION && r.tools).length;

const viewSrc = `(() => ({
  held: !!document.querySelector('[data-f01="held"]'),
  hint: document.querySelector(".held-hint")?.textContent ?? "",
  unconnected: document.body.innerText.includes("还没有连接模型"),
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

type PanelView = { held: boolean; hint: string; unconnected: boolean; pill: string; heldPending: boolean; users: string[]; text: string; morph: number | null; flip: number | null };

const readView = (rp: RealPath, panel: string) => rp.evaluate(panel, viewSrc) as Promise<PanelView>;

async function fillCustom(rp: RealPath, page: string, baseUrl: string, key: string): Promise<void> {
  await until(async () => (await rp.evaluate(page, `document.querySelectorAll(".provider-option").length`)) > 3 || undefined, 15_000, "设置页服务商");
  await rp.evaluate(page, `(() => { const more = document.querySelector("#provider-more"); if (more) more.open = true; return true; })()`);
  await rp.click(page, `.provider-option[data-provider="custom"]`);
  await until(async () => await rp.evaluate(page, `!document.querySelector("#provider-form").hidden`) || undefined, 5_000, "自定义表单");
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

async function sendHeld(rp: RealPath, panel: string): Promise<PanelView> {
  await rp.click(panel, "#input");
  await rp.typeText(panel, QUESTION);
  await rp.pressEnter(panel);

  return until(async () => { const v = await readView(rp, panel); return v.unconnected && v.users.some((u) => u.includes(QUESTION)) ? v : undefined; }, 30_000, "未连接卡");
}

async function saveCustom(rp: RealPath, panel: string, baseUrl: string, key: string): Promise<string> {
  await rp.click(panel, ".needs-model-card button, .receipt-decision button");
  const target = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url.endsWith("/settings.html")), 10_000, "设置页");
  const page = await rp.attach(target.targetId);
  await fillCustom(rp, page, baseUrl, key);
  await rp.evaluate(page, `document.querySelector("#model-save").scrollIntoView({ block: "center" }); true`);
  await rp.click(page, "#model-save");

  return page;
}

try {
  const rp = await launchRealPath();
  const panel = await openFreshPanel(rp);
  const held = await sendHeld(rp, panel);
  await rp.screenshot(panel, join(out, "01-held.png"));
  check("R1 未连接卡里的话带「连好后自动发」", held.held && held.hint.includes("连好后自动发") && held.users.some((u) => u.startsWith(QUESTION)), held);

  const settings = await saveCustom(rp, panel, denyUrl, "sk-invalid-0000");
  const fail = await until(async () => {
    const state = await rp.evaluate(settings, `({
      hidden: document.querySelector("#key-reason").hidden,
      reason: document.querySelector("#key-reason-text")?.textContent ?? "",
      wait: document.querySelector(".key-reason-wait")?.textContent ?? "",
      warn: document.querySelector("#api-key").classList.contains("warn"),
      status: document.querySelector("#model-status").textContent ?? "",
      tone: document.querySelector("#model-status").dataset.tone ?? "",
    })`);

    return !state.hidden && state.reason ? state : undefined;
  }, 45_000, "密钥原因");
  await rp.screenshot(settings, join(out, "02-invalid-key.png"));
  check("密钥无效：框下一行原因，不写红色「连接失败」", fail.reason.includes("服务商不接受这个密钥") && fail.wait.includes("侧栏里那句话还在等你") && fail.warn && !fail.status.includes("连接失败") && fail.tone !== "err", fail);
  check("密钥无效：没有保存，侧栏仍在等", (await readView(rp, panel)).unconnected && asked() === 0);

  await rp.evaluate(panel, watchSrc);
  await fillCustom(rp, settings, model.baseUrl, "local-fixture");
  await rp.evaluate(settings, `document.querySelector("#model-save").scrollIntoView({ block: "center" }); true`);
  await rp.click(settings, "#model-save");
  await until(async () => String(await rp.evaluate(settings, `document.querySelector("#model-status").textContent`)).startsWith("已保存") || undefined, 45_000, "保存成功");
  const answered = await until(async () => { const v = await readView(rp, panel); return v.text.includes(ANSWER) && !v.unconnected ? v : undefined; }, 45_000, "自动发出后的回答");
  await sleep(400);
  const after = await readView(rp, panel);
  await rp.screenshot(panel, join(out, "03-connected.png"));
  check("R2 连好后未连接卡不再出现", !after.unconnected && after.pill.includes("已连上"), after);
  check("R3 原话只发出一次，只有一个用户气泡", asked() === 1 && after.users.length === 1 && after.users[0]!.startsWith(QUESTION) && !!answered, { asked: asked(), users: after.users });
  check("R4 变形 240ms±20", after.morph != null && after.morph >= 220 && after.morph <= 260, after.morph);
  check("R4 FLIP 320ms±20", after.flip != null && after.flip >= 300 && after.flip <= 340, after.flip);
  await rp.close();
  await rp.remove();

  const reduced = await launchRealPath();
  const rpanel = await openFreshPanel(reduced, true);
  await sendHeld(reduced, rpanel);
  await reduced.evaluate(rpanel, watchSrc);
  const rsettings = await saveCustom(reduced, rpanel, model.baseUrl, "local-fixture");
  await until(async () => String(await reduced.evaluate(rsettings, `document.querySelector("#model-status").textContent`)).startsWith("已保存") || undefined, 45_000, "减少动效已保存");
  const rdone = await until(async () => { const v = await readView(reduced, rpanel); return v.text.includes(ANSWER) && !v.unconnected ? v : undefined; }, 45_000, "减少动效结束态");
  await reduced.screenshot(rpanel, join(out, "04-reduced-motion.png"));
  check("R4 减少动效：直接到结束态，不报变形时长", rdone.pill.includes("已连上") && !rdone.heldPending && rdone.morph == null && rdone.flip == null, rdone);
  await reduced.close();
  await reduced.remove();
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(out, "summary.json"), JSON.stringify({ status: error || results.some(([, pass]) => !pass) ? "FAIL" : "PASS", results, asked: asked(), error }, null, 2));
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
