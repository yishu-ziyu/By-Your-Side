/** 两个已打开的真侧栏在恢复后显示新记忆，不用重开。 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `memory-restore-live-${randomUUID()}`);
await mkdir(out, { recursive: true });
const now = Date.now();
const entry = (id: string, text: string) => ({ id, factId: id, version: 1, text, scope: { kind: "all" }, sourceConversationId: "seed", createdAt: now, updatedAt: now, kind: "profile", status: "active", sourceQuote: text, useCount: 0, formatVersion: 3 });
const old = JSON.stringify({ format: 3, rev: 1, entries: [entry("old", "原来的隔离记忆")] });
const fresh = JSON.stringify({ format: 3, rev: 2, entries: [entry("new", "恢复后的隔离记忆")] });
const fixture = join(out, "backup.json");
await writeFile(fixture, JSON.stringify({ format: "by-your-side-memory-backup", version: 1, savedAt: now, extensionVersion: "fixture", documents: { memories: fresh }, storage: {} }));
const model = await startScriptedModel([]);
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let result: Record<string, unknown> = {};
try {
  rp = await launchRealPath();
  const target = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html#data` })).targetId as string;
  const settings = await rp.attach(target);
  await until(() => rp!.evaluate(settings, '!!document.querySelector("#memory-backup-file")').catch(() => false), 30_000, "设置就绪");
  await rp.evaluate(settings, `new Promise((resolve,reject)=>{const q=indexedDB.open('sideagent-memory',1);q.onerror=()=>reject(q.error);q.onsuccess=()=>{const db=q.result,tx=db.transaction('kv','readwrite');tx.objectStore('kv').put(${JSON.stringify(old)},'memories');tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error)}})`);
  await rp.evaluate(settings, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(()=>true)`);
  const firstId = await rp.openSidePanel();
  const first = await rp.attach(firstId);
  const windowId = await rp.evaluate(settings, 'chrome.windows.create({url:"about:blank"}).then(w=>w.id)') as number;
  await rp.openSidePanel(windowId);
  const secondId = await until(async () => {
    const all = (await rp!.cdp.send("Target.getTargets")) as { targetInfos: Array<{ targetId: string; type: string; url: string }> };
    return all.targetInfos.find(t => t.targetId !== firstId && t.type === "page" && t.url.startsWith(`chrome-extension://${rp!.extensionId}/sidepanel.html`))?.targetId;
  }, 20_000, "第二个真侧栏");
  const second = await rp.attach(secondId);
  for (const panel of [first, second]) {
    await until(() => rp!.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false').catch(() => false), 60_000, "侧栏就绪");
    await rp.click(panel, "#memory-open");
    await until(() => rp!.evaluate(panel, 'document.querySelector("#memory-body")?.textContent.includes("原来的隔离记忆")').catch(() => false), 20_000, "原记忆显示");
  }
  await rp.screenshot(first, join(out, "before.png"));
  await rp.cdp.send("DOM.enable", {}, settings);
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: 0 }, settings) as { root: { nodeId: number } };
  const { nodeId } = await rp.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#memory-backup-file" }, settings) as { nodeId: number };
  await rp.cdp.send("DOM.setFileInputFiles", { nodeId, files: [fixture] }, settings);
  await until(() => rp!.evaluate(settings, '!document.querySelector("#memory-backup-confirm").hidden'), 10_000, "覆盖确认");
  await rp.click(settings, "#memory-backup-confirm");
  await until(() => rp!.evaluate(settings, 'document.querySelector("#memory-backup-status")?.textContent.includes("已恢复")'), 20_000, "恢复完成");
  for (const panel of [first, second]) await until(() => rp!.evaluate(panel, 'document.querySelector("#memory-body")?.textContent.includes("恢复后的隔离记忆") && !document.querySelector("#memory-body")?.textContent.includes("原来的隔离记忆")').catch(() => false), 20_000, "打开的侧栏自动刷新");
  await rp.screenshot(first, join(out, "after.png"));
  result = { panels: 2, refreshed: true, pass: true };
} catch (error) { result = { error: String(error), pass: false }; }
finally { await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2)); if (rp) { await rp.close(); await rp.remove(); } await model.close(); }
console.log(JSON.stringify({ ...result, out }));
if (!result.pass) process.exitCode = 1;
