/**
 * 按住说话第 2 步：网页底部胶囊（docs/evals/20261007-ptt-capsule.md R1–R4）。只装扩展、隔离构建、侧栏关着。
 *   npx tsx scripts/acceptance/real-path/ptt-capsule.mts --headless
 * 麦克风是 say 合成的一句话；听写连真实的 Step Plan 套餐，助手用本机脚本模型。
 * 第 1 轮：按住（在听、声波）→ 松开（听写中）→ 在做 → 结果，点「在侧栏看」打开侧栏。
 * 第 2 轮：同一句话，脚本模型挂起不回；胶囊在做时按 Esc，任务停下，胶囊写「已停下」。
 * 胶囊的 shadow root 是关着的：用它挂在宿主上的 data-phase / data-peak 判断步骤，内容看截图。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-ptt-capsule`);

await mkdir(artifacts, { recursive: true });

const SPOKEN = "把这三家公司整理成一张表，按营收排一下。";

const ANSWER = "已经按营收排好了表，Lumen 最高。第二句不该出现在胶囊里。";

const wav = join(artifacts, "microphone.wav");

execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@24000", `[[slnc 200]]${SPOKEN}[[slnc 600]]`]);

const speechMs = Math.round((((await readFile(wav)).length - 44) / 48_000) * 1000);

// 第 1 轮：先列一下标签页（有一个「当前步骤」），停 3 秒再回答，留出「在做」的时间。
const rule: Rule = { match: "整理成一张表", steps: [{ tool: { name: "tabs", args: { action: "list" } } }, { text: ANSWER, delayMs: 3_000 }] };

const model = await startScriptedModel([rule]);

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>三家候选供应商</title><body style="font:16px system-ui;padding:40px"><h1>三家候选供应商</h1><p>Lumen 光子、Harbor 港湾、Kite 风筝。</p>`));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const planKey = (await readFile(join(homedir(), ".sideagent", "step-plan.key"), "utf8")).trim();

const rp = await launchRealPath({ microphoneWav: wav });

let error: string | null = null;

/** 写进 result.json 的证据：每轮看到的步骤顺序、声波最高、各步耗时。 */
interface Evidence { speechMs: number; rounds: Array<{ phases: string[]; peakPx?: number; pillDuringCapsule?: string | null; ms: Record<string, number> }>; panelOpened?: boolean; sockets: string[] }

const evidence: Evidence = { speechMs, rounds: [], sockets: [] };

/** 胶囊宿主上的步骤；没有胶囊时为 null。 */
const capsuleState = (session: string) => rp.evaluate(session, `(() => { const h = document.querySelector('[data-sideagent-overlay="ptt-capsule"]'); return h ? { phase: h.dataset.phase ?? null, peak: Number(h.dataset.peak ?? 0) } : null; })()`) as Promise<{ phase: string | null; peak: number } | null>;

type DomNode = { nodeId: number; nodeName: string; nodeValue?: string; children?: DomNode[]; shadowRoots?: DomNode[] };

/** 关着的 shadow root 里按文字找按钮，点它的中心（CDP 能穿透，网页脚本不能）。 */
async function clickCapsuleButton(session: string, label: string): Promise<void> {
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, session) as { root: DomNode };
  const find = (node: DomNode): DomNode | null => {
    if (node.nodeName === "BUTTON" && node.children?.some(child => child.nodeValue === label)) return node;

    for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) { const hit = find(child); if (hit) return hit; }

    return null;
  };
  const button = find(root);
  assert.ok(button, `capsule button ${label}`);
  const { model: box } = await rp.cdp.send("DOM.getBoxModel", { nodeId: button.nodeId }, session) as { model: { content: number[] } };
  const x = (box.content[0]! + box.content[2]!) / 2, y = (box.content[1]! + box.content[5]!) / 2;

  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, session);
}

/** 按住右 ⌥ 说完整句再松开；按住期间记下步骤与声波，截一张图。返回松开的时刻。 */
async function holdAndSpeak(session: string, round: Evidence["rounds"][number], shot: string): Promise<number> {
  const key = { key: "Alt", code: "AltRight", windowsVirtualKeyCode: 18, location: 2 };
  const pressedAt = Date.now();
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key }, session);
  let shotTaken = false;

  while (Date.now() - pressedAt < speechMs + 400) {
    await sleep(100);
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", autoRepeat: true, ...key }, session);
    const state = await capsuleState(session);

    if (state?.phase && round.phases.at(-1) !== state.phase) round.phases.push(state.phase);
    round.peakPx = Math.max(round.peakPx ?? 0, state?.peak ?? 0);

    if (!shotTaken && Date.now() - pressedAt > speechMs / 2) { await rp.screenshot(session, shot); shotTaken = true; }
  }

  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, session);

  return Date.now();
}

/** 等胶囊到某一步，顺路记下经过的步骤。 */
async function waitPhase(session: string, round: Evidence["rounds"][number], phase: string, ms: number): Promise<void> {
  await until(async () => {
    const state = await capsuleState(session);

    if (state?.phase && round.phases.at(-1) !== state.phase) round.phases.push(state.phase);

    return state?.phase === phase || undefined;
  }, ms, `capsule ${phase}`, 50);
}

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/suppliers` }, work);

  const inproc = await rp.attach((await until(async () => (await rp.targets()).find(t => t.url.endsWith("/inproc.html")), 30_000, "offscreen document")).targetId);
  const items = { inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" }, inproc_voice_key: planKey };
  // SAFETY: CDP Target.createTarget 返回 { targetId }。
  const { targetId: settingsTarget } = await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html` }) as { targetId: string };
  const settings = await rp.attach(settingsTarget);
  await until(async () => await rp.evaluate(settings, "typeof chrome !== 'undefined' && !!chrome.storage?.local"), 15_000, "settings page");
  await rp.evaluate(settings, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await rp.cdp.send("Target.closeTarget", { targetId: settingsTarget });
  rp.cdp.onEvent("Network.webSocketCreated", (message: { sessionId?: string; params?: { url?: string } }) => { if (message.sessionId === inproc && message.params?.url) evidence.sockets.push(message.params.url); });
  await rp.cdp.send("Network.enable", {}, inproc);
  await sleep(1_500);
  await rp.cdp.send("Runtime.evaluate", { expression: "document.body.click(), true" }, work);

  // ── 第 1 轮 ──
  const one: Evidence["rounds"][number] = { phases: [], ms: {} };
  evidence.rounds.push(one);
  const released = await holdAndSpeak(work, one, join(artifacts, "1-listening.png"));
  assert.ok(one.phases.includes("listening"), `R1: listening while held ${JSON.stringify(one.phases)}`);
  assert.ok((one.peakPx ?? 0) > 8, `R1: the waveform moved with the voice (peak ${one.peakPx}px of 24)`);
  await waitPhase(work, one, "transcribing", 2_000);
  await waitPhase(work, one, "doing", 15_000);
  one.ms.doing = Date.now() - released;
  await sleep(600);
  await rp.screenshot(work, join(artifacts, "2-doing.png"));
  // SAFETY: 表达式返回字符串或 null。
  one.pillDuringCapsule = await rp.evaluate(work, `document.querySelector('[data-sideagent-overlay="edge-pill"]')?.dataset.state ?? null`) as string | null;
  assert.equal(one.pillDuringCapsule, null, "R4: the edge pill stays hidden on the capsule's page");
  await waitPhase(work, one, "done", 30_000);
  one.ms.done = Date.now() - released;
  await sleep(400);
  await rp.screenshot(work, join(artifacts, "3-done.png"));
  assert.deepEqual(one.phases.filter(p => p !== "transcribing"), ["listening", "doing", "done"], `R1–R3: phase order ${JSON.stringify(one.phases)}`);

  // R3：点「在侧栏看」打开侧栏，对话里有这句话。
  await clickCapsuleButton(work, "在侧栏看");
  const panelTarget = await until(async () => (await rp.targets()).find(t => t.url.includes("/sidepanel.html")), 10_000, "side panel opened from the capsule");
  const panel = await rp.attach(panelTarget.targetId);
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.user")].some(m => m.textContent.includes("整理成一张表"))`) || undefined, 15_000, "spoken sentence in panel");
  evidence.panelOpened = true;
  await rp.cdp.send("Target.closeTarget", { targetId: panelTarget.targetId }).catch(() => {});

  // ── 第 2 轮：模型挂起，Esc 停 ──
  rule.steps = [{ text: "这句不会来得及说完。", delayMs: 60_000 }];
  await clickCapsuleButton(work, "✕").catch(() => {});
  await sleep(500);
  const two: Evidence["rounds"][number] = { phases: [], ms: {} };
  evidence.rounds.push(two);
  const released2 = await holdAndSpeak(work, two, join(artifacts, "4-listening-again.png"));
  await waitPhase(work, two, "doing", 15_000);
  await sleep(1_000);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, work);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, work);
  const escAt = Date.now();
  await waitPhase(work, two, "stopped", 15_000);
  two.ms.stoppedAfterEsc = Date.now() - escAt;
  two.ms.doing = escAt - released2;
  await rp.screenshot(work, join(artifacts, "5-stopped.png"));

  assert.ok(evidence.sockets.length > 0 && evidence.sockets.every(url => url.startsWith("wss://api.stepfun.com/step_plan/v1/realtime")), `dictation only on the plan URL ${JSON.stringify(evidence.sockets)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
