// The real-extension driver shared by compare-real.mts and om2w.mts: one isolated Chrome with the built extension, the side panel open and signed in to the model.
import { join } from "node:path";

/** The panel shows a run in progress: the status pill, the stop button, an assistant reply still streaming, or the goal check still deciding whether to continue. */
export const BUSY = `(() => { const q = (s) => document.querySelector(s); return (q("#status-pill")?.classList.contains("running") ?? false) || (q("#send-btn")?.classList.contains("stopping") ?? false) || !!q(".msg.assistant.streaming, .msg.assistant[data-revealing], .thinking.streaming") || [...document.querySelectorAll(".run-check")].some((e) => e.textContent?.includes("核对中…")); })()`;

/** `root` is the repo whose harness and credentials helper are used; `tabs` are opened left to right and the user looks at the last one. */
export async function startExt(root: string, { model, tabs, cookies = [] }: { model: string; tabs: string[]; cookies?: object[] }) {
  const harness = await import(join(root, "scripts/acceptance/real-path/harness.mts"));
  const { storageItemsFor } = await import(join(root, "eval/harness/credentials.mjs"));
  const { until } = harness;
  const cfg = storageItemsFor(model);
  const rp = await harness.launchRealPath({ headed: true });
  try {
    const user: string = await rp.attach((await rp.targets()).find((t: { url: string }) => t.url === "about:blank")!.targetId);
    if (cookies.length) await rp.cdp.send("Storage.setCookies", { cookies });
    await rp.cdp.send("Page.navigate", { url: tabs.at(-1) }, user);
    const sw: string = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "sw")).targetId);
    const panel: string = await rp.attach(await rp.openSidePanel());
    await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(cfg.items)}).then(() => true)`);
    for (const [index, url] of tabs.slice(0, -1).entries()) await rp.evaluate(panel, `chrome.tabs.create(${JSON.stringify({ url, index, active: false })}).then(() => true)`);
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "panel ready");
    return { rp, user, sw, panel, harness };
  } catch (e) { await rp.close(); await rp.remove(); throw e; }
}

/** Every diagnostics trace line the extension has stored, in write order. */
export const traceLines = async (rp: any, panel: string) => String(await rp.evaluate(panel, `new Promise((ok) => { const r = indexedDB.open("sideagent-diagnostics"); r.onsuccess = () => { const q = r.result.transaction("trace-lines").objectStore("trace-lines").getAll(); q.onsuccess = () => ok(q.result.map(x => x.line).join("")); }; r.onerror = () => ok(""); })`));

/** Types the prompt into the panel and sends it. */
export async function send(rp: any, panel: string, prompt: string) {
  await rp.click(panel, "#input"); await rp.typeText(panel, prompt); await rp.pressEnter(panel);
}

/** Waits until the run has started and then been quiet for 4 s, or `capMs` after `t0`; `tick` runs on every poll. */
export async function waitIdle(rp: any, panel: string, t0: number, capMs: number, tick?: () => Promise<void>) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const by = Date.now() + 20_000; Date.now() < by && !(await rp.evaluate(panel, BUSY).catch(() => false));) await sleep(250);
  let quietSince = 0, quiet = false;
  while (Date.now() - t0 < capMs) { await tick?.(); const b = await rp.evaluate(panel, BUSY); quietSince = b ? 0 : (quietSince || Date.now()); if (quietSince && Date.now() - quietSince > 4000) { quiet = true; break; } await sleep(250); }
  return { ms: (quietSince || Date.now()) - t0, capped: !quiet };
}
