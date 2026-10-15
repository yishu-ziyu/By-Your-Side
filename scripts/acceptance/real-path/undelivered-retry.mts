/**
 * 一句话没送达，用户点气泡上的「重试」：还是原来那一个气泡，「未送达」去掉、得到回答；重开侧栏后也只有这一个气泡。
 * 后台已经没有那条历史时（后台重启、旧历史没落盘），「重试」照原文另发一条：还是只有一个气泡，不会停在「已重试」。
 *   npx tsx scripts/acceptance/real-path/undelivered-retry.mts --headless
 * 脚本模型，只装扩展。「没送达」的造法：扩展内 agent 的 offscreen 文档一出现就关掉（反复崩溃），
 * 这期间从侧栏页再开一条面板端口发出这句。侧栏自己的发送在断线时会把草稿退回输入框，碰不到后台转发失败那一步，
 * 所以借第二条端口走同一个后台入口；被测的记录、标记、重试、回放都是真的。
 * 「历史没了」的造法：从存储里删掉那一条，再停掉后台 service worker，它重启时只读回剩下的。
 * 失败方式：点了「重试」多出第二个同样的气泡；原气泡还挂着「未送达」；重开侧栏后变成两个气泡，或旧的那个又标回未送达；
 * 后台对没有的那条不回话；历史没了时按钮停在「已重试」、气泡没了，或旧的未送达气泡留着。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-undelivered-retry`);

await mkdir(artifacts, { recursive: true });

const ASK = "未送达重试验收：海獭用什么敲开贝壳？";

const ANSWER = "海獭用石头敲开贝壳。";

const ASK_GONE = "未送达重试验收：海獭睡觉时怎么不被冲走？";

const ANSWER_GONE = "海獭睡觉时手牵着手。";

const model = await startScriptedModel([{ match: ASK, steps: [{ text: ANSWER }] }, { match: ASK_GONE, steps: [{ text: ANSWER_GONE }] }]);

const rp = await launchRealPath();

const evidence: Record<string, unknown> = {};

let error: string | null = null;

/** 侧栏里写着这句话的用户气泡：有几个、各自有没有「未送达」、是不是点「重试」前的那个元素，以及有没有回答。 */
const bubblesOf = (ask: string, answer: string) => `(() => {
  const all = [...document.querySelectorAll(".msg.user")].filter((m) => (m.querySelector(".user-msg-text")?.textContent ?? m.textContent ?? "").includes(${JSON.stringify(ask)}));
  return {
    count: all.length,
    marked: all.map((m) => m.classList.contains("undelivered") || !!m.querySelector(".delivery-tag")),
    retryButtons: all.map((m) => !!m.querySelector("[data-retry]")),
    oldElement: all.map((m) => m.hasAttribute("data-case-old")),
    answered: (document.querySelector("#messages")?.textContent ?? "").includes(${JSON.stringify(answer)}),
  };
})()`;

const BUBBLES = bubblesOf(ASK, ANSWER);

type Bubbles = { count: number; marked: boolean[]; retryButtons: boolean[]; oldElement: boolean[]; answered: boolean };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 2, mobile: false }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await sleep(1000);

  const connected = async (label: string) => {
    await until(async () => (await rp.evaluate(panel, `document.querySelector("#status-dot")?.classList.contains("on") === true`)) || undefined, 45_000, label);
    await sleep(1000);
  };

  /** 扩展内 agent 反复崩溃期间，从第二条面板端口发出这句，等真实侧栏给它标上未送达，再放开、等连接恢复。 */
  const undeliver = async (ask: string, answer: string, shot: string) => {
    let crashing = true;
    let crashes = 0;
    const crashLoop = (async () => {
      while (crashing) {
        const doc = (await rp.targets()).find((t) => t.url === `chrome-extension://${rp.extensionId}/inproc.html`);
        if (doc && (await rp.cdp.send("Target.closeTarget", { targetId: doc.targetId }).then(() => true, () => false))) crashes++;
        await sleep(50);
      }
    })();

    await until(async () => (await rp.evaluate(panel, `document.querySelector("#status-dot")?.classList.contains("on") === false`)) || undefined, 15_000, "侧栏显示断开");
    await rp.evaluate(panel, `(() => { window.__extraPort ??= chrome.runtime.connect({ name: "sideagent-panel" }); window.__extraPort.postMessage({ kind: "client", msg: { type: "user_message", text: ${JSON.stringify(ask)} } }); return true; })()`);
    const state = await until(async () => {
      const got = await rp.evaluate(panel, bubblesOf(ask, answer)) as Bubbles; // SAFETY: bubblesOf 只返回这个形状。
      return got.retryButtons.some(Boolean) ? got : undefined;
    }, 15_000, "气泡标上未送达");
    await sleep(300);
    await rp.screenshot(panel, join(artifacts, shot));
    crashing = false;
    await crashLoop;
    await connected("连接恢复");

    return { ...state, crashes };
  };

  const before = await undeliver(ASK, ANSWER, "1-undelivered.png");
  evidence.before = before;

  const requestsBefore = model.requests.filter((r) => r.rule === ASK).length;
  await rp.click(panel, ".msg.user [data-retry]");
  const after = await until(async () => {
    const state = await rp.evaluate(panel, BUBBLES) as Bubbles; // SAFETY: 同上。
    return state.answered ? state : undefined;
  }, 30_000, "重试后得到回答");
  await sleep(1500);
  const settled = await rp.evaluate(panel, BUBBLES) as Bubbles; // SAFETY: 同上。
  await rp.screenshot(panel, join(artifacts, "2-after-retry.png"));
  evidence.after = after;
  evidence.settled = settled;
  evidence.modelRequests = model.requests.filter((r) => r.rule === ASK).length - requestsBefore;

  // 后台对没有的那条也要回话：从第二条端口要求重发一个不存在的 seq，只回给它，真实侧栏不受影响。
  const goneReply = await rp.evaluate(panel, `new Promise((done) => {
    const port = window.__extraPort;
    const seen = (m) => { if (m?.kind === "delivery" && m.seq === 987654) { port.onMessage.removeListener(seen); done(m); } };
    port.onMessage.addListener(seen);
    port.postMessage({ kind: "redeliver", seq: 987654 });
    setTimeout(() => done(null), 5000);
  })`) as { ok?: boolean; reason?: string } | null; // SAFETY: 回执就是 delivery 这个形状，等不到是 null。
  await sleep(500);
  evidence.goneReply = goneReply;
  evidence.afterGoneReply = await rp.evaluate(panel, BUBBLES);

  await rp.cdp.send("Page.reload", {}, panel);
  const reopened = await until(async () => {
    const state = await rp.evaluate(panel, BUBBLES) as Bubbles; // SAFETY: 同上。
    return state.answered ? state : undefined;
  }, 30_000, "重开侧栏后回放出这一轮");
  await sleep(1000);
  const reopenedSettled = await rp.evaluate(panel, BUBBLES) as Bubbles; // SAFETY: 同上。
  await rp.screenshot(panel, join(artifacts, "3-reopened.png"));
  evidence.reopened = reopenedSettled;

  // 后台已经没有那条历史：从存储里删掉它，马上停掉后台；侧栏重连时后台只读回剩下的历史。
  await connected("重开后连接就绪");
  evidence.goneBefore = await undeliver(ASK_GONE, ANSWER_GONE, "4-gone-undelivered.png");
  const work = await rp.attach((await rp.targets()).find((t) => t.type === "page" && !t.url.startsWith("chrome-extension://"))!.targetId);
  await rp.cdp.send("ServiceWorker.enable", {}, work);
  evidence.goneRemoved = await rp.evaluate(panel, `chrome.storage.local.get(null).then(async (all) => {
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith("history:") || !Array.isArray(value?.entries)) continue;
      const kept = value.entries.filter((e) => !(e.item?.kind === "user" && e.item.text === ${JSON.stringify(ASK_GONE)}));
      if (kept.length === value.entries.length) continue;
      await chrome.storage.local.set({ [key]: { ...value, entries: kept } });
      return { key, removed: value.entries.length - kept.length, laterEntries: kept.filter((e) => e.seq > Math.max(...value.entries.filter((x) => x.item?.text === ${JSON.stringify(ASK_GONE)}).map((x) => x.seq))).length };
    }
    return null;
  })`);
  await rp.cdp.send("ServiceWorker.stopAllWorkers", {}, work);
  await sleep(1500);
  await connected("后台重启后连接恢复");
  await rp.evaluate(panel, `(() => { const m = [...document.querySelectorAll(".msg.user")].find((b) => b.textContent.includes(${JSON.stringify(ASK_GONE)})); m.setAttribute("data-case-old", ""); return true; })()`);
  const goneRequestsBefore = model.requests.filter((r) => r.rule === ASK_GONE).length;
  await rp.click(panel, ".msg.user[data-case-old] [data-retry]");
  await until(async () => (await rp.evaluate(panel, bubblesOf(ASK_GONE, ANSWER_GONE)) as Bubbles).answered || undefined, 30_000, "历史没了时重试后得到回答");
  await sleep(1500);
  const goneAfter = await rp.evaluate(panel, bubblesOf(ASK_GONE, ANSWER_GONE)) as Bubbles; // SAFETY: 同上。
  await rp.screenshot(panel, join(artifacts, "5-gone-after-retry.png"));
  evidence.goneAfter = goneAfter;
  evidence.goneModelRequests = model.requests.filter((r) => r.rule === ASK_GONE).length - goneRequestsBefore;
  await rp.cdp.send("Page.reload", {}, panel);
  await until(async () => (await rp.evaluate(panel, bubblesOf(ASK_GONE, ANSWER_GONE)) as Bubbles).answered || undefined, 30_000, "历史没了的那句：重开侧栏后回放");
  await sleep(1000);
  const goneReopened = await rp.evaluate(panel, bubblesOf(ASK_GONE, ANSWER_GONE)) as Bubbles; // SAFETY: 同上。
  await rp.screenshot(panel, join(artifacts, "6-gone-reopened.png"));
  evidence.goneReopened = goneReopened;

  assert.deepEqual({ count: before.count, marked: before.marked }, { count: 1, marked: [true] }, `重试前：一个气泡，标着未送达：${JSON.stringify(before)}`);
  assert.deepEqual({ count: settled.count, marked: settled.marked, answered: settled.answered }, { count: 1, marked: [false], answered: true }, `重试后：还是一个气泡，未送达去掉，有回答：${JSON.stringify(settled)}`);
  assert.deepEqual({ count: reopenedSettled.count, marked: reopenedSettled.marked, answered: reopened.answered }, { count: 1, marked: [false], answered: true }, `重开侧栏后：一个气泡，没有未送达：${JSON.stringify(reopenedSettled)}`);
  assert.deepEqual({ ok: goneReply?.ok, reason: goneReply?.reason }, { ok: false, reason: "gone" }, `后台对不存在的那条回 gone：${JSON.stringify(goneReply)}`);
  assert.equal((evidence.afterGoneReply as Bubbles).count, 1, "gone 只回给发起的端口，真实侧栏不另发");
  assert.ok((evidence.goneRemoved as { removed?: number } | null)?.removed === 1, `存储里删掉了那一条：${JSON.stringify(evidence.goneRemoved)}`);
  assert.deepEqual({ count: goneAfter.count, marked: goneAfter.marked, oldElement: goneAfter.oldElement, retryButtons: goneAfter.retryButtons, requests: evidence.goneModelRequests }, { count: 1, marked: [false], oldElement: [false], retryButtons: [false], requests: 1 }, `历史没了时重试：旧气泡拿掉，另发的一条得到回答：${JSON.stringify(goneAfter)}`);
  assert.deepEqual({ count: goneReopened.count, marked: goneReopened.marked }, { count: 1, marked: [false] }, `历史没了的那句重开侧栏后：一个气泡，没有未送达：${JSON.stringify(goneReopened)}`);
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
