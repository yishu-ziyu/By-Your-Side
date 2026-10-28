/** 隔离扩展：恢复中断不能留下混合记忆。 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, until } from "./harness.mts";

requireHeadless();
const storageFailure = process.argv.includes("--storage-failure");
const restartDuringRestore = process.argv.includes("--restart-during-restore");
const out = join(REPO, "out/acceptance/real-path", `memory-restore-atomic-${randomUUID()}`);
await mkdir(out, { recursive: true });
const before = { memories: JSON.stringify({ entries: [{ id: "old-memory", status: "active", text: "原记忆" }] }), tasks: JSON.stringify({ tasks: [{ id: "old-task", title: "原任务" }] }), "site-notes": JSON.stringify({ sites: { old: "原站点" } }) };
const incoming = { memories: JSON.stringify({ entries: [{ id: "new-memory", status: "active", text: "新记忆" }] }), tasks: JSON.stringify({ tasks: [{ id: "new-task", title: "新任务" }] }), "site-notes": JSON.stringify({ sites: { fresh: "新站点" } }) };
const backup = { format: "by-your-side-memory-backup", version: 1, savedAt: Date.now(), extensionVersion: "fixture", documents: incoming, storage: storageFailure || restartDuringRestore ? { sideagent_browse_habits: true } : {} };
const file = join(out, "fixture.json"); await writeFile(file, JSON.stringify(backup));
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let result: Record<string, unknown> = {};
try {
  rp = await launchRealPath();
  const target = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html#data` })).targetId as string;
  let settings = await rp.attach(target);
  await until(() => rp!.evaluate(settings, '!!document.querySelector("#memory-backup-file") && !document.querySelector(\'[data-settings-panel="data"]\').hidden').catch(() => false), 30_000, "设置的备份页面就绪");
  await rp.evaluate(settings, `new Promise((resolve,reject)=>{const q=indexedDB.open('sideagent-memory',1);q.onerror=()=>reject(q.error);q.onsuccess=()=>{const db=q.result,tx=db.transaction('kv','readwrite'),s=tx.objectStore('kv');for(const [k,v] of Object.entries(${JSON.stringify(before)}))s.put(v,k);tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error)}})`);
  if (storageFailure || restartDuringRestore) await rp.evaluate(settings, `chrome.storage.local.set({sideagent_browse_habits:false}).then(()=>true)`);
  await rp.cdp.send("DOM.enable", {}, settings);
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: 0 }, settings) as { root: { nodeId: number } };
  const { nodeId } = await rp.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#memory-backup-file" }, settings) as { nodeId: number };
  await rp.cdp.send("DOM.setFileInputFiles", { nodeId, files: [file] }, settings);
  await until(() => rp!.evaluate(settings, 'document.querySelector("#memory-backup-confirm")?.hidden===false'), 10_000, "覆盖确认出现");
  if (restartDuringRestore) await rp.evaluate(settings, `(()=>{const original=chrome.storage.local.set.bind(chrome.storage.local);window.__restoreBlocked=false;chrome.storage.local.set=function(value){if(Object.hasOwn(value,'sideagent_browse_habits')){window.__restoreBlocked=true;return new Promise(()=>{})}return original(value)};return true})()`);
  else if (storageFailure) await rp.evaluate(settings, `(()=>{const original=chrome.storage.local.set.bind(chrome.storage.local);let fail=true;chrome.storage.local.set=function(value){if(fail && Object.hasOwn(value,'sideagent_browse_habits')){fail=false;return Promise.reject(new Error('fixture-storage-failure'))}return original(value)};return true})()`);
  else await rp.evaluate(settings, `(()=>{const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){if(this.name==='kv' && key==='tasks')throw new Error('fixture-write-failure');return original.call(this,value,key)};return true})()`);
  await rp.click(settings, "#memory-backup-confirm");
  if (restartDuringRestore) {
    await until(() => rp!.evaluate(settings, 'window.__restoreBlocked===true'), 15_000, "恢复卡在浏览设置写入");
    const worker = await rp.serviceWorker();
    if (!worker) throw new Error("扩展后台不可用");
    await rp.evaluate(settings, 'setTimeout(()=>chrome.runtime.reload(),0), true');
    await until(async () => { const next = await rp!.serviceWorker(); return next && next.targetId !== worker.targetId ? next : false; }, 30_000, "扩展后台重新启动");
    const next = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html#data` })).targetId as string;
    settings = await rp.attach(next);
    await until(() => rp!.evaluate(settings, '!!document.querySelector("#memory-backup-status")').catch(() => false), 30_000, "设置重新打开");
    await until(() => rp!.evaluate(settings, `new Promise(resolve=>{const q=indexedDB.open('sideagent-memory',1);q.onerror=()=>resolve(false);q.onsuccess=()=>{const db=q.result,tx=db.transaction('kv'),r=tx.objectStore('kv').get('memory-restore-journal-v1');r.onsuccess=()=>resolve(r.result===undefined);tx.oncomplete=()=>db.close()}})`), 30_000, "恢复记录已回滚");
  } else await until(() => rp!.evaluate(settings, 'document.querySelector("#memory-backup-status")?.textContent.includes("恢复失败")'), 15_000, "恢复失败提示");
  const actual = await rp.evaluate(settings, `new Promise((resolve,reject)=>{const q=indexedDB.open('sideagent-memory',1);q.onerror=()=>reject(q.error);q.onsuccess=()=>{const db=q.result,tx=db.transaction('kv'),s=tx.objectStore('kv'),keys=['memories','tasks','site-notes'],values={};for(const k of keys){const r=s.get(k);r.onsuccess=()=>values[k]=r.result}tx.oncomplete=()=>{db.close();resolve(values)};tx.onerror=()=>reject(tx.error)}})`) as Record<string, string>;
  const browse = storageFailure || restartDuringRestore ? await rp.evaluate(settings, 'chrome.storage.local.get("sideagent_browse_habits").then(s=>s.sideagent_browse_habits)') : false;
  const retained = Object.keys(before).every(k => actual[k] === before[k as keyof typeof before]) && browse === false;
  result = { actual, before, browse, storageFailure, restartDuringRestore, retained, pass: retained };
} catch (error) { result = { error: String(error), pass: false }; }
finally { await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2)); if (rp) { await rp.close(); await rp.remove(); } }
console.log(JSON.stringify({ ...result, out }));
if (!result.pass) process.exitCode = 1;
