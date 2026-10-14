/**
 * 出错→恢复收成一行（docs/evals/20261012-error-recovery-line.md）：断网出错 → 再出错 → 恢复接着做 → 原位一行回执；
 * 以及一轮「说做完了但有一步没做成」，「没做成」那行写人话原因，后台重启后原因还在。
 *   npx tsx scripts/acceptance/real-path/error-recovery-show.mts --headless        （OUT=/dir 可改产物目录）
 * 只装扩展、隔离构建、本机脚本模型、本机练习页；目标核对拿到的是脚本模型的「好的。」，没有结论。
 * 判据只看侧栏里用户看得到的内容：
 *   一 恢复后回执「出过错 · …，已从出错处继续」在出错的位置，答案在它下面，错误卡不再可见，断网重试时始终只有 1 张卡。
 *   二 点不可用的「提交」后模型说做完了：回答原文不带宿主补的「还没全部完成」；「没做成」那行写「目标现在不可用」，不写步骤名。
 *   三 只重启扩展内 agent（关掉 offscreen 文档）：重启后那行仍写「目标现在不可用」（检查点恢复带着原因）。
 *   四 把这条会话的检查点改成 10-04 以前按计划列目标的旧记录（一个还没核验的目标），再重启：受阻的步骤在投影里不成行，
 *      那行仍写「没做成：目标现在不可用」，不写「还没确认完成：…」。现行产品已不会新建这种计划，只有旧会话恢复时会遇到。
 *   五 再问一句：发给模型的任务快照里没有侧栏用的人话原因（它可能取自网页原文）。
 * 失败方式：恢复时不抄原因，三失败；原因只从投影出来的行里取，四失败；快照不剥掉原因，五失败。
 * 产物：OUT/*.png、OUT/error.mp4、OUT/notdone.mp4、OUT/result.json。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const OUT = process.env.OUT ?? join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-error-recovery-show`);
await mkdir(OUT, { recursive: true });

const ASK_NET = "出错恢复演示：总结这页";
const ASK_DONE = "出错恢复演示：点提交";
const REASON = "目标现在不可用";
const ASK_FOLLOW = "出错恢复演示：刚才哪一步没成";
/** 模型收到的全部文字：侧栏用的人话原因不能出现在里面（它可能取自网页原文）。 */
const modelTexts: string[] = [];
const target = { target: "" };
const model = await startScriptedModel([
  { match: ASK_NET, steps: [{ text: "这页讲的是三条退货规则：七天无理由、拆封不退、运费买家出。", chunkDelayMs: 120 }] },
  { match: ASK_DONE, steps: [{ tool: { name: "snapshot", args: {} } }, { tool: { name: "click", args: target } }, { text: "已经点了「提交」，表单提交好了。" }] },
  { match: ASK_FOLLOW, steps: [{ text: "是点「提交」那一步。" }] },
], undefined, (payload) => {
  for (const m of payload.messages ?? []) {
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((part) => part.text ?? "").join("") : "";
    modelTexts.push(text);
    const ref = /\[ref=(\d+)\] button "提交"/.exec(text)?.[1];
    if (m.role === "tool" && ref) target.target = `@${ref}`;
  }
});

let netDown = false;
const front = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += String(chunk);
  if (netDown && /"tools"\s*:\s*\[\s*\{/.test(body)) { req.socket.destroy(); return; }
  const up = await fetch(`${model.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? body : undefined });
  res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await up.arrayBuffer()));
});
await new Promise<void>(r => front.listen(0, "127.0.0.1", r));
const site = createServer((_q, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>订单</title><h1>退货申请</h1><p>七天无理由；拆封不退；运费买家出。</p><button id="submit" type="button" disabled>提交</button>`));
await new Promise<void>(r => site.listen(0, "127.0.0.1", r));

const evidence: Record<string, Json> = {};
let failure: string | null = null;
const rp = await launchRealPath();
let panel = "";
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `http://127.0.0.1:${siteAddress(front).port}/v1` }, "inproc_cred:custom": { type: "api_key", key: "k" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "ready");
  const visible = (s: string) => rp.evaluate(panel, `(() => { const el = document.querySelector(${JSON.stringify(s)}); return !!el && el.getClientRects().length > 0; })()`);
  const shot = (n: string) => rp.screenshot(panel, join(OUT, `${n}.png`));
  const send = async (ask: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, ask); await rp.pressEnter(panel); };
  const cards = () => rp.evaluate(panel, 'document.querySelectorAll(".error-card").length') as Promise<number>;
  /** 「没做成」那行（继续原任务卡上唯一的一行）；卡没出现时为空。 */
  const resumeLine = () => rp.evaluate(panel, `(() => { const r = document.querySelector("#resume-entry-root"); return r && !r.hidden ? r.querySelector(".resume-line")?.textContent ?? "" : ""; })()`) as Promise<string>;

  // 一：断网出错、再错、恢复接着做。
  let stop = await recordScreen(rp.cdp, panel, join(OUT, "error.mp4"));
  netDown = true;
  await send(ASK_NET);
  await until(async () => await visible('.error-card [data-act="retry"]') || undefined, 60_000, "card");
  await sleep(600); await shot("1-error-card");
  await rp.click(panel, '.error-card [data-act="retry"]');
  await sleep(150); await shot("2-retrying");
  await until(async () => await visible(".error-card.is-recovering") === false && await visible('.error-card [data-act="retry"]') || undefined, 60_000, "card again");
  await sleep(120); await shot("3-error-again");
  assert.equal(await cards(), 1, "一：重试又失败时仍是同一张卡");
  await sleep(1200);
  netDown = false;
  await rp.click(panel, '.error-card [data-act="retry"]');
  await sleep(150); await shot("4-recovering");
  await until(async () => /三条退货规则/.test(String(await rp.evaluate(panel, 'document.querySelector("#messages").textContent'))) || undefined, 60_000, "answer");
  await sleep(2500); await shot("5-recovered");
  console.log("error.mp4", await stop());
  const recovered = await rp.evaluate(panel, `(() => {
    const line = [...document.querySelectorAll(".error-receipt")].at(-1);
    const answer = [...document.querySelectorAll("#messages .msg.assistant")].at(-1);
    return { line: line?.textContent ?? null, before: line && answer ? (line.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : null };
  })()`) as { line: string | null; before: boolean | null };
  evidence.recovered = recovered;
  assert.match(recovered.line ?? "", /^出过错 · .+，已从出错处继续$/, "一：恢复后留一行回执");
  assert.equal(recovered.before, true, "一：回执在出错的位置，答案在它下面");
  assert.equal(await visible(".error-card"), false, "一：恢复后错误卡不再可见");

  // 二：说做完了，但「提交」不可用 → 没做成。
  await rp.evaluate(panel, `document.querySelector("#messages").scrollTop = 1e6`);
  stop = await recordScreen(rp.cdp, panel, join(OUT, "notdone.mp4"));
  await send(ASK_DONE);
  await until(async () => /已经点了/.test(String(await rp.evaluate(panel, 'document.querySelector("#messages").textContent'))) || undefined, 90_000, "done answer");
  const before = await until(async () => (await resumeLine()) || undefined, 30_000, "没做成那行");
  await sleep(1500); await shot("6-notdone");
  await rp.evaluate(panel, `[...document.querySelectorAll("details.run-steps > summary")].at(-1)?.click()`);
  await sleep(800); await shot("7-notdone-steps");
  console.log("notdone.mp4", await stop());
  const answer = String(await rp.evaluate(panel, '[...document.querySelectorAll("#messages .msg.assistant")].at(-1)?.textContent ?? ""'));
  evidence.notDone = { line: before, answer };
  assert.equal(before, `没做成：${REASON}`, "二：没做成那行写人话原因");
  assert.doesNotMatch(answer, /没全部完成|还有没做完/, "二：回答原文不带宿主补的一句");

  /** 只关掉扩展内 agent（offscreen 文档），等它重新起来；侧栏落到新会话时点回原任务。 */
  const restartAgent = async (label: string) => {
    const url = `chrome-extension://${rp.extensionId}/inproc.html`;
    const old = (await rp.targets()).find(t => t.url === url);
    assert.ok(old, "找不到 offscreen 文档");
    await rp.cdp.send("Target.closeTarget", { targetId: old.targetId });
    await until(async () => (await rp.targets()).some(t => t.url === url && t.targetId !== old.targetId) || undefined, 30_000, `${label}：扩展内 agent 重新起来`);
    // 重启前那行还挂着；等侧栏收到新 agent 的任务视图（行变了，或稳定几秒后再读）。
    const deadline = Date.now() + 20_000;
    let line = "";
    while (Date.now() < deadline) {
      const away = await rp.evaluate(panel, `(() => { const b = document.querySelector("#conversation-background"); return !!b && !b.hidden && b.textContent.includes(${JSON.stringify(ASK_DONE.slice(0, 6))}); })()`);
      if (away) await rp.click(panel, "#conversation-background");
      line = await resumeLine();
      await sleep(500);
    }
    await shot(label);
    return line;
  };

  // 三：后台重启后原因还在。
  const afterRestart = await restartAgent("8-after-restart");
  evidence.afterRestart = afterRestart;
  assert.equal(afterRestart, `没做成：${REASON}`, "三：后台重启后仍写人话原因");

  // 四：检查点换成按计划列目标的旧记录（一个没核验的目标），再重启。
  const seeded = await rp.evaluate(panel, `(async () => {
    const db = await new Promise((ok, no) => { const r = indexedDB.open("sideagent-session-data", 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    const store = () => db.transaction("items", "readwrite").objectStore("items");
    const req = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    const keys = await req(store().getAllKeys());
    for (const key of keys) {
      const item = await req(store().get(key));
      if (!item || item.directory || !String(item.text).includes(${JSON.stringify(ASK_DONE)})) continue;
      const lines = item.text.split("\\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        const entry = JSON.parse(lines[i]);
        if (entry.type !== "custom" || !["sideagent-task-results-v1", "sideagent-task-acceptance-v1"].includes(entry.customType)) continue;
        const snap = entry.customType === "sideagent-task-acceptance-v1" ? entry.data.snapshot : entry.data;
        snap.goalPlan = { revision: "legacy-plan", coverage: "verified", goals: [{ id: "submit-return", description: "提交退货申请", criterion: "退货申请已提交", requirements: ["requirement-1"], kind: "condition", status: "pending" }] };
        lines[i] = JSON.stringify(entry);
        await req(store().put({ ...item, text: lines.join("\\n"), modifiedAt: Date.now() }, key));
        return { key, blocked: (snap.results ?? []).filter(r => r.status === "blocked").map(r => ({ description: r.description, reason: r.reason ?? null })) };
      }
    }
    return null;
  })()`) as { key: string; blocked: Array<{ description: string; reason: string | null }> } | null;
  evidence.seeded = seeded;
  assert.ok(seeded && seeded.blocked.some(r => r.reason === REASON), `四：检查点里有带原因的受阻步骤：${JSON.stringify(seeded)}`);
  const legacy = await restartAgent("9-legacy-plan");
  evidence.legacyPlan = legacy;
  assert.equal(legacy, `没做成：${REASON}`, "四：按计划列目标的旧检查点恢复后仍写人话原因");

  // 下一句话带着任务快照发给模型：快照里不能有侧栏用的人话原因。
  await send(ASK_FOLLOW);
  await until(async () => /是点「提交」那一步/.test(String(await rp.evaluate(panel, 'document.querySelector("#messages").textContent'))) || undefined, 60_000, "follow-up answer");
  const leaked = modelTexts.filter((text) => text.includes(REASON)).map((text) => text.slice(Math.max(0, text.indexOf(REASON) - 80), text.indexOf(REASON) + 40));
  evidence.modelLeak = leaked;
  assert.equal(leaked.length, 0, `五：模型收到的内容里没有侧栏用的原因：${JSON.stringify(leaked)}`);
} catch (e) {
  failure = String(e);
  console.error(e);
  await rp.screenshot(panel, join(OUT, "failure.png")).catch(() => {});
} finally {
  evidence.messages = await rp.evaluate(panel, '[...document.querySelectorAll("#messages > *")].map(el => el.className + ": " + el.textContent.slice(0, 120))').catch(() => null);
  await writeFile(join(OUT, "result.json"), JSON.stringify({ status: failure ? "FAIL" : "PASS", evidence, failure }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); front.closeAllConnections(); front.close(); site.close();
}
console.log(failure ? "FAIL" : "PASS", OUT);
if (failure) process.exitCode = 1;
