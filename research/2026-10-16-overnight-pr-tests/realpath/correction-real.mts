// 真实模型 + 真实侧栏（launchRealPath.openSidePanel）跑 #483 中途纠正。复制进分支的 scripts/acceptance/real-path/ 下运行。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { launchRealPath, until, sleep, exportDiagnosticsViaSettings } from "./harness.mts";
const [url, first, steer, tag] = [process.env.URL!, process.env.FIRST!, process.env.STEER!, process.env.TAG!];
const out = `/workspace/proto-bot/overnight/runs/${tag}`; mkdirSync(out, { recursive: true });
const key = JSON.parse(readFileSync("/home/box/.pi/agent/auth.json", "utf8"))["minimax-cn"].key;
const model = process.env.MODEL ?? "MiniMax-M3.1-Flash-Preview";
const rp = await launchRealPath();
const r: Record<string, unknown> = { tag, model, url };
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "minimax-cn", modelId: model }, "inproc_cred:minimax-cn": { type: "api_key", key } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, "document.querySelector('#send-btn')?.disabled===false") || undefined, 60_000, "ready");
  await rp.cdp.send("Page.bringToFront", {}, work); await sleep(1500);
  const send = async (s: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, s); await rp.pressEnter(panel); };
  const running = async () => !!(await rp.evaluate(panel, "document.querySelector('#send-btn')?.classList.contains('stopping')"));
  await send(first);
  await until(async () => (await running()) || undefined, 30_000, "running").catch(() => null);
  await sleep(2500); r.runningAtSteer = await running();
  await send(steer);
  await sleep(3000); const t = Date.now(); while (Date.now() - t < 180_000) { if (!(await running())) { await sleep(3000); if (!(await running())) break; } await sleep(500); }
  await sleep(10_000);
  r.cards = await rp.evaluate(panel, `[...document.querySelectorAll("[data-memory-ask]")].map(c => ({ state: c.dataset.state, line: c.querySelector(".memory-ask-line")?.textContent ?? "", undo: !!c.querySelector("[data-memory-ask-undo]") }))`);
  await rp.screenshot(panel, `${out}/learned-panel.png`);
  if (process.env.UNDO && (r.cards as Array<{ undo: boolean }>).some(c => c.undo)) { await rp.click(panel, "[data-memory-ask-undo]"); await sleep(2500); r.afterUndo = await rp.evaluate(panel, `[...document.querySelectorAll("[data-memory-ask]")].map(c => c.querySelector(".memory-ask-line")?.textContent ?? "")`); await rp.screenshot(panel, `${out}/after-undo-panel.png`); }
  const diag = await exportDiagnosticsViaSettings(rp as never, (rp as unknown as { extensionId: string }).extensionId, `${out}/diag`).catch(e => ({ traces: "ERR " + e }));
  r.memoryDecisions = String((diag as { traces: string }).traces).split("\n").filter(l => l.includes("memory_ask")).map(l => l.slice(0, 600));
} catch (e) { r.error = String(e); }
writeFileSync(`${out}/result.json`, JSON.stringify(r, null, 1)); console.log("RESULT", JSON.stringify(r));
await rp.close?.(); process.exit(0);
