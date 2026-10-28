/** 只有站点笔记时，恢复缺少该笔记的备份也必须先确认。 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, until } from "./harness.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `memory-restore-site-confirm-${randomUUID()}`);
await mkdir(out, { recursive: true });
const fixture = join(out, "backup.json");
await writeFile(fixture, JSON.stringify({ format: "by-your-side-memory-backup", version: 1, savedAt: 0, extensionVersion: "fixture", documents: { memories: JSON.stringify({ entries: [{ id: "new", text: "备份记忆", status: "active" }] }) }, storage: {} }));
const old = JSON.stringify({ sites: { "fixture.example": "需要确认的笔记" } });
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let settings: string | undefined;
let result: Record<string, unknown> = {};
try {
  rp = await launchRealPath();
  const target = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html#data` })).targetId as string;
  settings = await rp.attach(target);
  await until(() => rp!.evaluate(settings!, '!!document.querySelector("#memory-backup-status")').catch(() => false), 30_000, "设置就绪");
  await rp.evaluate(settings, `new Promise((resolve,reject)=>{const q=indexedDB.open('sideagent-memory',1);q.onerror=()=>reject(q.error);q.onsuccess=()=>{const db=q.result,tx=db.transaction('kv','readwrite');tx.objectStore('kv').put(${JSON.stringify(old)},'site-notes');tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error)}})`);
  await rp.cdp.send("DOM.enable", {}, settings);
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: 0 }, settings) as { root: { nodeId: number } };
  const { nodeId } = await rp.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#memory-backup-file" }, settings) as { nodeId: number };
  await rp.cdp.send("DOM.setFileInputFiles", { nodeId, files: [fixture] }, settings);
  await until(() => rp!.evaluate(settings!, '!document.querySelector("#memory-backup-confirm").hidden'), 8_000, "覆盖确认");
  const message = await rp.evaluate(settings, 'document.querySelector("#memory-backup-status").textContent') as string;
  await rp.screenshot(settings, join(out, "confirmation.png"));
  if (!message.includes("站点笔记") || !message.includes("清除")) throw new Error(`未说明站点笔记会被清除：${message}`);
  const readSite = `new Promise((resolve,reject)=>{const q=indexedDB.open('sideagent-memory',1);q.onerror=()=>reject(q.error);q.onsuccess=()=>{const db=q.result,tx=db.transaction('kv'),r=tx.objectStore('kv').get('site-notes');r.onsuccess=()=>resolve(r.result??null);tx.oncomplete=()=>db.close()}})`;
  if (await rp.evaluate(settings, readSite) !== old) throw new Error("确认之前笔记已经被改动");
  await rp.click(settings, "#memory-backup-confirm");
  await until(() => rp!.evaluate(settings!, 'document.querySelector("#memory-backup-status")?.textContent.includes("已恢复")'), 15_000, "恢复完成");
  const after = await rp.evaluate(settings, readSite);
  result = { message, clearedAfterApproval: after === null, pass: after === null };
} catch (error) {
  result = { error: String(error), pass: false };
  if (rp && settings) await rp.screenshot(settings, join(out, "failure.png")).catch(() => {});
} finally { await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2)); if (rp) { await rp.close(); await rp.remove(); } }
console.log(JSON.stringify({ ...result, out }));
if (!result.pass) process.exitCode = 1;
