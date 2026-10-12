/**
 * 出错→恢复的演示录制：断网出错 → 再出错 → 恢复接着做 → 回执；以及一轮「说做完了但有一步没做成」。
 *   OUT=/dir npx tsx scripts/acceptance/real-path/error-recovery-show.mts --headless
 * 产物：OUT/*.png、OUT/error.mp4、OUT/notdone.mp4。只拍真实扩展，不做判据。
 */
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const OUT = process.env.OUT!;
await mkdir(OUT, { recursive: true });

const ASK_NET = "出错恢复演示：总结这页";
const ASK_DONE = "出错恢复演示：点提交";
const target = { target: "" };
const model = await startScriptedModel([
  { match: ASK_NET, steps: [{ text: "这页讲的是三条退货规则：七天无理由、拆封不退、运费买家出。", chunkDelayMs: 120 }] },
  { match: ASK_DONE, steps: [{ tool: { name: "snapshot", args: {} } }, { tool: { name: "click", args: target } }, { text: "已经点了「提交」，表单提交好了。" }] },
], undefined, (payload) => {
  for (const m of payload.messages ?? []) {
    const text = typeof m.content === "string" ? m.content : "";
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

const rp = await launchRealPath();
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `http://127.0.0.1:${siteAddress(front).port}/v1` }, "inproc_cred:custom": { type: "api_key", key: "k" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "ready");
  const visible = (s: string) => rp.evaluate(panel, `(() => { const el = document.querySelector(${JSON.stringify(s)}); return !!el && el.getClientRects().length > 0; })()`);
  const shot = (n: string) => rp.screenshot(panel, join(OUT, `${n}.png`));
  const send = async (ask: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, ask); await rp.pressEnter(panel); };

  // 场景一：断网出错、再错、恢复接着做。
  let stop = await recordScreen(rp.cdp, panel, join(OUT, "error.mp4"));
  netDown = true;
  await send(ASK_NET);
  await until(async () => await visible('.error-card [data-act="retry"]') || undefined, 60_000, "card");
  await sleep(600); await shot("1-error-card");
  await rp.click(panel, '.error-card [data-act="retry"]');
  await sleep(150); await shot("2-retrying");
  await until(async () => await visible(".error-card.is-recovering") === false && await visible('.error-card [data-act="retry"]') || undefined, 60_000, "card again");
  await sleep(120); await shot("3-error-again");
  await sleep(1200);
  netDown = false;
  await rp.click(panel, '.error-card [data-act="retry"]');
  await sleep(150); await shot("4-recovering");
  await until(async () => /三条退货规则/.test(String(await rp.evaluate(panel, 'document.querySelector("#messages").textContent'))) || undefined, 60_000, "answer");
  await sleep(2500); await shot("5-recovered");
  console.log("error.mp4", await stop());

  // 场景二：说做完了，但「提交」不可用 → 没做成。
  await rp.evaluate(panel, `document.querySelector("#messages").scrollTop = 1e6`);
  stop = await recordScreen(rp.cdp, panel, join(OUT, "notdone.mp4"));
  await send(ASK_DONE);
  await until(async () => /已经点了/.test(String(await rp.evaluate(panel, 'document.querySelector("#messages").textContent'))) || undefined, 90_000, "done answer");
  await sleep(6000); await shot("6-notdone");
  await rp.evaluate(panel, `document.querySelector(".process-block summary, .steps-toggle, [data-act=steps]")?.click()`).catch(() => {});
  await sleep(800); await shot("7-notdone-steps");
  console.log("notdone.mp4", await stop());
  console.log("messages", JSON.stringify(await rp.evaluate(panel, '[...document.querySelectorAll("#messages > *")].map(el => el.className + ": " + el.textContent.slice(0, 120))')));
} finally {
  await rp.close(); await rp.remove(); await model.close(); front.closeAllConnections(); front.close(); site.close();
}
