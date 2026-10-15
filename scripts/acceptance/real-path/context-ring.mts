/**
 * 模型按钮上的对话用量（docs/evals/20261015-context-ring.md）：悬停看「这段对话占了 N%」，占到一半在模型名旁画环，重开侧栏还在，新对话清空。
 *   npx tsx scripts/acceptance/real-path/context-ring.mts --headless
 * 脚本模型答两句，各报一次用量（20%、70%，其中大半是缓存命中），窗口按自定义服务的 12.8 万。只装扩展。
 * 失败方式：20% 时就画了环；悬停不出卡片、卡片里百分比或万字不对、卡片出了侧栏右边；70% 时没有环或环画的比例不对；
 * 缓存命中没算进用量；窄侧栏（300 宽）里环被收掉；重开侧栏后环或卡片没了；新对话还留着上一段的用量。
 * 截图：after-20.png、after-70.png、after-70-300.png、after-reopen.png、after-new.png（before 用 SIDEAGENT_ACCEPTANCE_DIST 指到旧版构建再跑一次）。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-context-ring`);

await mkdir(artifacts, { recursive: true });

const SMALL = "先简单说一句你能做什么。";

const BIG = "把刚才读过的都总结一下。";

// 自定义服务的窗口是 128000：25600 是 20%，89600 是 70%。
const model = await startScriptedModel([
  { match: SMALL, steps: [{ text: "我能帮你读网页、填表、整理资料。", usage: { prompt: 25_600, cached: 20_000 } }] },
  { match: BIG, steps: [{ text: "读过的内容总结好了。", usage: { prompt: 89_600, cached: 80_000 } }] },
]);

const rp = await launchRealPath();

const evidence: Record<string, unknown> = {};

let error: string | null = null;

let panel = "";

const idle = `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")`;

/** 用户看得到的：环在不在、画了多少，开关的读屏名字和系统提示，用量卡片显没显示、写了什么、在不在侧栏里。 */
const STATE = `(() => {
  const chip = document.querySelector("#think-chip");
  const ring = chip?.querySelector(".think-ring");
  const ringBox = ring?.getBoundingClientRect();
  const pop = document.querySelector("#ctx-pop");
  const box = pop?.getBoundingClientRect();
  const shown = !!pop && getComputedStyle(pop).visibility === "visible" && Number(getComputedStyle(pop).opacity) > 0.9;
  return { ring: !!ringBox && ringBox.width > 0 && ringBox.height > 0, fill: ring ? Number(ring.style.getPropertyValue("--ctx-fill")) : null,
    label: chip?.getAttribute("aria-label") ?? null, title: chip?.getAttribute("title") ?? null, chipText: chip?.innerText.replace(/\\s+/g, " ").trim() ?? null,
    pop: shown ? pop.innerText.replace(/\\s+/g, " ").trim() : null, popInside: shown ? box.left >= 0 && box.right <= innerWidth : null };
})()`;

type State = { ring: boolean; fill: number | null; label: string | null; title: string | null; chipText: string | null; pop: string | null; popInside: boolean | null };

const read = async (): Promise<State> => {
  const value = await rp.evaluate(panel, STATE);
  assert.ok(value && typeof value === "object" && "ring" in value, `读不到开关：${JSON.stringify(value)}`);

  return value as State; // SAFETY: 上面查过是 STATE 返回的对象，STATE 只返回这个形状。
};

const hover = async (on: boolean) => {
  const at = on ? await rp.evaluate(panel, `(() => { const r = document.querySelector("#think-chip").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as { x: number; y: number } : { x: 5, y: 5 };
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" }, panel);
  await sleep(400);
};

const width = (w: number) => rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: 760, deviceScaleFactor: 2, mobile: false }, panel);

const openPanel = async () => {
  panel = await rp.attach(await rp.openSidePanel());
  await width(400);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
};

const ask = async (text: string) => {
  await hover(false);
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  await sleep(1500);
  await until(async () => (await rp.evaluate(panel, idle)) || undefined, 60_000, text, 300);
  await sleep(500);
};

try {
  await openPanel();
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => (await rp.evaluate(panel, `!document.querySelector("#think-chip")?.hidden`)) || undefined, 60_000, "模型按钮出现");

  await ask(SMALL);
  const small = await read();
  await hover(true);
  const smallHover = await read();
  await rp.screenshot(panel, join(artifacts, "after-20.png"));

  await ask(BIG);
  const big = await read();
  await hover(true);
  const bigHover = await read();
  await rp.screenshot(panel, join(artifacts, "after-70.png"));

  await width(300);
  await sleep(300);
  await hover(true);
  const narrow = await read();
  await rp.screenshot(panel, join(artifacts, "after-70-300.png"));

  await rp.cdp.send("Target.closeTarget", { targetId: (await rp.targets()).find((t) => t.url.includes("sidepanel"))!.targetId }).catch(() => undefined);
  await sleep(1000);
  await openPanel();
  await until(async () => (await rp.evaluate(panel, `!document.querySelector("#think-chip")?.hidden && !!document.querySelector(".msg.assistant")`)) || undefined, 60_000, "重开后回放完");
  await sleep(800);
  await hover(true);
  const reopened = await read();
  await rp.screenshot(panel, join(artifacts, "after-reopen.png"));

  await hover(false);
  await rp.click(panel, "#conversation-new");
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && !document.querySelector(".msg.assistant") && ${idle}`)) || undefined, 60_000, "新对话");
  await sleep(500);
  await hover(true);
  const fresh = await read();
  await rp.screenshot(panel, join(artifacts, "after-new.png"));

  Object.assign(evidence, { small, smallHover, big, bigHover, narrow, reopened, fresh });

  const SMALL_LINE = "这段对话占了 20%（约 2.6 万 / 12.8 万字）";
  const BIG_LINE = "这段对话占了 70%（约 9 万 / 12.8 万字）";
  assert.equal(small.ring, false, "20% 时模型名旁没有环");
  assert.ok(smallHover.pop?.includes(SMALL_LINE) && smallHover.pop.includes("装不下时会把早先读过的网页收成一行") && smallHover.popInside, `20% 时悬停出卡片、写着 20%、在侧栏里：${JSON.stringify(smallHover)}`);
  assert.ok(small.label?.startsWith("模型：demo-model") && small.label.includes(SMALL_LINE) && small.title === null, `读屏名字带模型和用量、不叠系统提示：${JSON.stringify(small)}`);
  assert.ok(big.ring && big.fill === 0.7, `70% 时有环、画了 70%（缓存命中也算进去）：${JSON.stringify(big)}`);
  assert.ok(bigHover.pop?.includes(BIG_LINE) && bigHover.popInside, `70% 时悬停卡片写着 70%：${JSON.stringify(bigHover)}`);
  assert.equal(big.chipText, small.chipText, "开关上的字只有模型名，不夹带卡片里的字");
  assert.ok(narrow.ring && narrow.pop?.includes(BIG_LINE) && narrow.popInside, `300 宽环还在、卡片不出侧栏：${JSON.stringify(narrow)}`);
  assert.ok(reopened.ring && reopened.fill === 0.7 && reopened.pop?.includes(BIG_LINE), `重开侧栏还是 70%：${JSON.stringify(reopened)}`);
  assert.ok(!fresh.ring && fresh.pop === null && fresh.title === "模型：demo-model" && fresh.label === "模型：demo-model", `新对话不留上一段的用量：${JSON.stringify(fresh)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
