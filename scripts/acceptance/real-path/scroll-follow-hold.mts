/**
 * 回答还在往下写时，用户往上滚一点就停在那里，不被拉回底部；滚回离底部 40px 以内就重新跟着写。
 *   npx tsx scripts/acceptance/real-path/scroll-follow-hold.mts --headless [--record]
 * 脚本模型慢慢写一段长回答。写到一半，在对话区上用真实鼠标滚轮往上滚一格（-40、-60、-100 各一轮），
 * 之后 1.5 秒每 50ms 读一次滚动位置：一直停在滚到的地方，不往底部回，“回到底部”圆钮要出来。
 * 再用滚轮滚回底部：一直到回答写完，每次读数都离底部不超过 40px（docs/evals/20261015-scroll-follow-hold.md）。
 * 不点圆钮：回答还在写时输入框盖住了圆钮的中心，点上去落在输入框上（evidence.json 里的 buttonHit 记着）。
 * --record：同时录屏到 out/…/scroll.mp4，只给人看，不参与判定。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const record = process.argv.includes("--record");
const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-scroll-follow-hold`);

await mkdir(artifacts, { recursive: true });

const TASK = "把这几款扫地机器人的续航和价格逐段比一下";
const LONG = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段：按售价除以续航，B7 每分钟约 11.9 元，A1 约 12.7 元，C3 约 13.7 元；B7 的尘盒更大，A1 更安静。`).join("\n\n");

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>评测合集</title><h1>扫地机器人评测合集</h1>"));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const model = await startScriptedModel([{ match: TASK, steps: [{ text: LONG, chunkDelayMs: 40 }] }]);
const rp = await launchRealPath();
const evidence: Record<string, unknown> = {};
let error: string | null = null;
let stopRecording: (() => Promise<string | null>) | null = null;

type Sample = { t: number; top: number; gap: number; button: boolean; streaming: boolean };

const SAMPLE = `(() => { const m = document.querySelector("#messages");
  return { top: Math.round(m.scrollTop), gap: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight), button: !document.querySelector("#to-bottom").hidden,
    streaming: !document.querySelector("#messages .msg.assistant .answer-actions") }; })()`;

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  if (record) stopRecording = await recordScreen(rp.cdp, panel, join(artifacts, "scroll.mp4"));

  const sample = async (t0: number): Promise<Sample> => ({ t: Date.now() - t0, ...(await rp.evaluate(panel, SAMPLE) as Omit<Sample, "t">) });
  const center = await rp.evaluate(panel, `(() => { const r = document.querySelector("#messages").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`) as { x: number; y: number };

  for (const [turn, deltaY] of [-40, -60, -100].entries()) {
    if (turn > 0) {
      await rp.click(panel, "#conversation-new");
      await until(async () => (await rp.evaluate(panel, `!document.querySelector("#messages .msg.assistant") && document.querySelector("#send-btn")?.disabled === false`)) || undefined, 10_000, "新对话就绪");
    }

    await rp.click(panel, "#input");
    await rp.typeText(panel, TASK);
    await rp.pressEnter(panel);
    // 对话区已经能滚、离写完还早时才滚。
    await until(async () => { const s = await rp.evaluate(panel, SAMPLE) as Omit<Sample, "t">; return s.streaming && s.top > 600; }, 60_000, `第 ${turn + 1} 轮回答写到可滚`, 50);

    const t0 = Date.now();
    const before = await sample(t0);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: center.x, y: center.y, deltaX: 0, deltaY }, panel);
    const held: Sample[] = [before];
    while (Date.now() - t0 < 1500) { held.push(await sample(t0)); await sleep(50); }
    await rp.screenshot(panel, join(artifacts, `held-${-deltaY}.png`));
    evidence[`wheel${deltaY}`] = held;
    const after = held.slice(1).filter((s) => s.t >= 300);
    assert.ok(after.every((s) => s.streaming), `滚动后 1.5 秒内回答还在写（第 ${turn + 1} 轮），不然判不了`);
    assert.ok(after.every((s) => s.top <= before.top + deltaY + 1 && s.gap >= -deltaY - 1), `滚轮 ${deltaY} 后停在原处，不被拉回底部：${held.map((s) => `${s.t}ms top=${s.top} gap=${s.gap}`).join(" | ")}`);
    assert.ok(after.every((s) => s.button), `滚轮 ${deltaY} 后“回到底部”圆钮出来`);

    evidence[`buttonHit${deltaY}`] = await rp.evaluate(panel, `(() => { const b = document.querySelector("#to-bottom"), r = b.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { rect: [r.x, r.y, r.width, r.height].map(Math.round), hit: hit ? hit.tagName + "#" + hit.id + "." + hit.className : null, ok: !!hit && b.contains(hit) }; })()`);
    // 用户滚回离底部 40px 以内，就重新跟着写。
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: center.x, y: center.y, deltaX: 0, deltaY: 100_000 }, panel);
    const t1 = Date.now();
    const followed: Sample[] = [];
    for (let s = await sample(t1); ; s = await sample(t1)) { followed.push(s); if (!s.streaming) break; await sleep(50); }
    evidence[`follow${deltaY}`] = followed;
    const lagging = followed.filter((s) => s.t >= 200 && s.gap > 40);
    assert.deepEqual(lagging, [], `滚回底部后一直跟到回答写完（第 ${turn + 1} 轮）`);
    assert.ok(followed.length > 5, "滚回底部后回答还写了一阵，跟随确实被检查到");
    await rp.screenshot(panel, join(artifacts, `followed-${-deltaY}.png`));
  }
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
} finally {
  if (stopRecording) evidence.video = await stopRecording();
  await writeFile(join(artifacts, "evidence.json"), JSON.stringify({ error, ...evidence }, null, 2));
  await rp.close();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(error ? `FAIL ${error}` : "PASS scroll-follow-hold", "\n证据：", artifacts);
if (error) process.exitCode = 1;
