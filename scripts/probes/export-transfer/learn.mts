/**
 * 从纠正中学习（docs/evals/20261008-learn-from-correction.md）：网站 A 上犯错 → 用户纠正 → 卡片「要我记住吗」→ 点「记住」
 * （--confirm=all 时再把范围切成所有网站）→ 网站 B 新对话做 T2、T3。一次运行一个新隔离 Chrome、空记忆。真实模型。
 *   npx tsx scripts/probes/export-transfer/learn.mts --headless --confirm=default|all --out=<目录> [--model=provider/id]
 *
 * 可能假通过的方式与堵法：
 * - 网站 A 第一次就做对，「纠正」成了无的放矢 → L1 不成立就停，记「未复现」。
 * - 只看卡片出没出，不看存了什么 → 点「记住」后从扩展 IndexedDB 读回生效记忆的原文与范围。
 * - 两站同域名，网站 A 的记忆「假装」到了 B → 两站用不同域名（host-resolver-rules）。
 * - 记忆没到 B，B 站做对了也算「判断对」→ 逐条查 B 站主任务请求原文里有没有那条记忆；没到记「没到达」。
 * - B 站做 T3 时混入 T2 的下载或网站记录 → 每个任务只看它开始之后的新文件和新事件。
 * - 卡片里切了范围但库里没变 → 范围以库里读回的为准，卡片文字只作旁证。
 */
import { readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, sleep, until } from "../../acceptance/real-path/harness.mts";
import { DEFAULT_TEST_MODEL, configureViaSettings, loadModelPlan, modelStorageItems } from "../../acceptance/real-path/inproc-config.mts";
import { PAGE_SIZE, startSite } from "./site.mts";
import { captureModelBodies, judge, waitDone, lastNewCsv, readMemories, seedKnowledge } from "./shared.mts";
import { SENTENCES } from "./sentences.mts";

requireHeadless();
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const confirm = arg("confirm") as "default" | "all";
const out = arg("out")!;
if (!["default", "all"].includes(confirm) || !out) throw new Error("用法见文件头");
await mkdir(out, { recursive: true });

/** 用户的纠正：只说问题，不教步骤。 */
const CORRECTION = "不对，你只导出了当前页的 20 条，我要的是全部 200 条。";
const HOST_A = "shop-a.test";
const HOST_B = "shop-b.test";

const plan = await loadModelPlan(arg("model") ?? DEFAULT_TEST_MODEL);
const siteA = await startSite("A");
const siteB = await startSite("B");
const port = (url: string) => new URL(url).port;
const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP ${HOST_A} 127.0.0.1:${port(siteA.url)}, MAP ${HOST_B} 127.0.0.1:${port(siteB.url)}`, "--no-proxy-server"] });
const idle = `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")`;
const result: Record<string, unknown> = { confirm, model: `${plan.providerId}/${plan.modelId}`, correction: CORRECTION };
let panel = "";
let work = "";
/** 每一轮结束时最后一行过程标题；仍是「还没做完，接着做」就说明收卷早了。 */
const titles: string[] = [];

const lastReply = async () => String(await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].at(-1)?.innerText.slice(0, 500) ?? ""`));

async function say(text: string) {
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  await sleep(1500);
  titles.push(await waitDone(rp, panel, `做完：${text}`));
}

async function open(host: string) {
  await rp.cdp.send("Page.navigate", { url: `http://${host}/` }, work);
  await until(async () => (await rp.evaluate(work, `location.hostname === ${JSON.stringify(host)} && document.querySelectorAll("#rows tr").length === ${PAGE_SIZE}`).catch(() => false)) || undefined, 15_000, `打开 ${host}`);
}

async function newConversation() {
  await rp.click(panel, "#conversation-new");
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && ${idle}`)) || undefined, 60_000, "新对话");
}

/** 真点卡片里的按钮（同 remember-corrections.mts 的 clickInAsk）。 */
async function clickInAsk(selector: string): Promise<boolean> {
  const found = await rp.evaluate(panel, `(() => { const b = [...document.querySelectorAll("[data-memory-ask]")].at(-1)?.querySelector(${JSON.stringify(selector)}); if (!b) return false; b.setAttribute("data-acceptance-click", "1"); b.scrollIntoView({ block: "center" }); return true; })()`);
  if (!found) return false;
  await sleep(300);
  await rp.click(panel, "[data-acceptance-click]");
  await rp.evaluate(panel, `document.querySelector("[data-acceptance-click]")?.removeAttribute("data-acceptance-click"); true`);

  return true;
}

const card = async () => (await rp.evaluate(panel, `(() => { const el = [...document.querySelectorAll("[data-memory-ask]")].at(-1); return el ? { text: el.innerText.replace(/\\s+/g, " ").trim(), scope: el.querySelector("[data-memory-ask-scope]")?.innerText.trim() ?? null, remember: !!el.querySelector('[data-memory-ask-answer="remember"]') } : null; })()`)) as { text: string; scope: string | null; remember: boolean } | null;

/** L3 预判：只按词，最后由人读原文定稿。 */
const prelabel = (rule: string) => {
  const condition = /如果|若|默认|当.{0,12}时|先确认|核对|检查|条数|是否/.test(rule);
  const steps = /全选|勾选|选择全部\s*200|点击|点「|点"|按钮|200 ?位/.test(rule);

  return condition && !steps ? "知识" : steps && !condition ? "步骤" : steps && condition ? "混合" : "只有目标";
};

/** 在网站 B 新对话里做一个任务：判分，并查那条记忆有没有进这次的主任务请求。 */
async function onB(task: "T2" | "T3", bodies: Awaited<ReturnType<typeof captureModelBodies>>, memoryText: string | null) {
  await open(HOST_B);
  await newConversation();
  const before = new Set(await readdir(rp.dirs.downloads));
  const eventMark = siteB.events.length;
  const bodyMark = bodies.list.length;
  const started = Date.now();
  await say(SENTENCES[task]);
  const got = await lastNewCsv(rp.dirs.downloads, before);
  const events = siteB.events.slice(eventMark);
  const main = (await bodies.texts()).slice(bodyMark).filter((b) => b.includes(SENTENCES[task]) && b.includes('"browser_run"'));
  // 到达 = 至少一条主任务请求带着它（续做的请求可能另组上下文）；条数照记。
  const withMemory = memoryText ? main.filter((b) => b.includes(memoryText)).length : 0;
  const reached = withMemory > 0;

  return {
    verdicts: judge(task, got?.ids ?? [], events), reached, mainRequests: main.length, withMemory, seconds: Math.round((Date.now() - started) / 1000) - 15,
    rows: got?.ids.length ?? 0, exports: events.filter((e) => e.type === "export").map((e) => `${e.mode}:${e.count}${e.head ? "(全选已勾)" : ""}`),
    events: events.filter((e) => e.type !== "export").map((e) => `${e.type}${e.checked !== undefined ? `=${e.checked}` : ""}${e.value ? `=${e.value}` : ""}`),
    reply: await lastReply(),
  };
}

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  work = await rp.attach(blank.targetId);
  await open(HOST_A);
  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  if (plan.credential.type === "api_key") await configureViaSettings(rp, panel, plan);
  else await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
  await sleep(3000);
  const bodies = await captureModelBodies(rp);
  await seedKnowledge(rp, null);
  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });
  await newConversation();

  // L1：网站 A 第一次。
  let before = new Set(await readdir(rp.dirs.downloads));
  await say(SENTENCES.T1);
  const first = await lastNewCsv(rp.dirs.downloads, before);
  result.first = { rows: first?.ids.length ?? 0, reply: await lastReply() };
  result.L1 = (first?.ids.length ?? 0) === 200 ? "未复现" : "复现";

  if (result.L1 === "复现") {
    // 用户纠正；Agent 可能接着改对，照记。
    before = new Set(await readdir(rp.dirs.downloads));
    await say(CORRECTION);
    const after = await lastNewCsv(rp.dirs.downloads, before);
    result.afterCorrection = { rows: after?.ids.length ?? null, reply: await lastReply() };
    await rp.screenshot(panel, join(out, "A-after-correction.png")).catch(() => undefined);

    // L2：卡片与规则。卡片可能在回答之后才出。
    const ask = await until(async () => { const c = await card(); return c?.remember ? c : undefined; }, 30_000, "要我记住吗").catch(() => null);
    result.card = ask?.text ?? null;
    result.L2 = ask ? "PASS" : "FAIL";

    if (ask) {
      await clickInAsk('[data-memory-ask-answer="remember"]');
      const remembered = await until(async () => { const c = await card(); return c?.scope ? c : undefined; }, 15_000, "记住了").catch(() => null);
      result.scopeOnCard = remembered?.scope ?? null;

      if (confirm === "all") {
        await clickInAsk("[data-memory-ask-scope]");
        result.scopeOnCard = (await until(async () => { const c = await card(); return c?.scope && /所有网站/.test(c.scope) ? c : undefined; }, 15_000, "范围变成所有网站").catch(() => null))?.scope ?? result.scopeOnCard;
      }

      await rp.screenshot(panel, join(out, "A-remembered.png")).catch(() => undefined);
      const saved = (await readMemories(rp)).filter((e) => e.kind === "method");
      result.saved = saved;
      const rule = saved.at(-1)?.text ?? null;
      result.rule = rule;
      result.L3prelabel = rule ? prelabel(rule) : null;

      // L4：网站 B。
      result.T2 = await onB("T2", bodies, rule);
      await rp.screenshot(panel, join(out, "B-T2.png")).catch(() => undefined);
      result.T3 = await onB("T3", bodies, rule);
      await rp.screenshot(panel, join(out, "B-T3.png")).catch(() => undefined);
    }
  }
} catch (caught) {
  result.error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  if (panel) result.panelText = await rp.evaluate(panel, `document.querySelector("#messages")?.innerText.slice(-2000)`).catch(() => null);
  if (panel) await rp.screenshot(panel, join(out, "failure-panel.png")).catch(() => undefined);
} finally {
  result.titles = titles;
  await writeFile(join(out, "result.json"), JSON.stringify({ ...result, siteA: siteA.events, siteB: siteB.events }, null, 2));
  await rp.close(); await rp.remove();
  for (const s of [siteA, siteB]) { s.server.closeAllConnections(); s.server.close(); }
}

console.log(JSON.stringify({ confirm, L1: result.L1 ?? null, L2: result.L2 ?? null, rule: result.rule ?? null, prelabel: result.L3prelabel ?? null, T2: (result.T2 as { verdicts?: unknown; reached?: boolean } | undefined) ?? null, T3: (result.T3 as { verdicts?: unknown; reached?: boolean } | undefined) ?? null, error: String(result.error ?? "").split("\n")[0] || null }));
