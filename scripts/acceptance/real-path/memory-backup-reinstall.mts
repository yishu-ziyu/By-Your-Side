/** 在隔离 Chrome 卸载扩展、重装，再从真实备份文件恢复。 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, until } from "./harness.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `memory-backup-reinstall-${randomUUID()}`);
await mkdir(out, { recursive: true });
const docs = { memories: JSON.stringify({ entries: [{ id: "fixture-memory", status: "active", text: "重装后仍在" }] }), tasks: JSON.stringify({ tasks: [{ id: "fixture-task", title: "过往任务" }] }), "site-notes": JSON.stringify({ sites: { "fixture.example": "站点笔记" } }) };
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let result: Record<string, unknown> = {};
try {
  rp = await launchRealPath({ unpackedViaCdp: true });
  const browser = rp.browser;
  if (!browser.includes("155.")) throw new Error(`不是 Chrome 155：${browser}`);
  let target = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html#data` })).targetId as string;
  let settings = await rp.attach(target);
  await until(() => rp!.evaluate(settings, '!!document.querySelector("#memory-backup-status")').catch(() => false), 30_000, "设置就绪");
  await rp.evaluate(settings, 'window.__backupOwners=[];chrome.downloads.onCreated.addListener(item=>window.__backupOwners.push({downloadId:item.id,id:item.byExtensionId,url:item.url?.startsWith("data:application/x-by-your-side-memory-backup+json;base64,")}));true');
  await rp.evaluate(settings, `new Promise((resolve,reject)=>{const q=indexedDB.open('sideagent-memory',1);q.onerror=()=>reject(q.error);q.onsuccess=()=>{const db=q.result,tx=db.transaction('kv','readwrite'),s=tx.objectStore('kv');for(const [k,v] of Object.entries(${JSON.stringify(docs)}))s.put(v,k);tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error)}})`);
  await rp.evaluate(settings, 'chrome.runtime.sendMessage({type:"memory_backup_changed"}).then(()=>true)');
  const last = await until(async () => await rp!.evaluate(settings, 'chrome.storage.local.get("memory_backup_last").then(s=>s.memory_backup_last ?? null)') as { file?: string } | null, 30_000, "备份落盘");
  if (!last.file) throw new Error("备份没有文件名");
  const ownership = await rp.evaluate(settings, 'window.__backupOwners') as Array<{downloadId:number;id?:string;url:boolean}>;
  console.log("download ownership", JSON.stringify({expected:rp.extensionId,ownership}));
  const registered = await rp.evaluate(settings, 'chrome.storage.local.get("memory_backup_download").then(s=>s.memory_backup_download)') as {id:number;urlHash:string};
  if (!ownership.some(item => (item.id === rp!.extensionId || item.downloadId === registered?.id && /^[a-f0-9]{64}$/.test(registered.urlHash)) && item.url)) throw new Error("下载归属未与真实返回ID绑定");
  const path = join(rp.dirs.downloads, last.file);
  const saved = JSON.parse(await readFile(path, "utf8"));
  if (Object.entries(docs).some(([key, text]) => saved.documents[key] !== text)) throw new Error("备份文件内容不符");
  await rp.cdp.send("Extensions.uninstall", { id: rp.extensionId });
  await rp.restart();
  target = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html#data` })).targetId as string;
  settings = await rp.attach(target);
  await until(() => rp!.evaluate(settings, '!!document.querySelector("#memory-backup-file")').catch(() => false), 30_000, "重装后的设置就绪");
  const read = `new Promise((resolve,reject)=>{const q=indexedDB.open('sideagent-memory',1);q.onupgradeneeded=()=>{if(!q.result.objectStoreNames.contains('kv'))q.result.createObjectStore('kv')};q.onerror=()=>reject(q.error);q.onsuccess=()=>{const db=q.result,tx=db.transaction('kv'),s=tx.objectStore('kv'),v={};for(const k of ${JSON.stringify(Object.keys(docs))}){const r=s.get(k);r.onsuccess=()=>v[k]=r.result??null}tx.oncomplete=()=>{db.close();resolve(v)};tx.onerror=()=>reject(tx.error)}})`;
  const empty = await rp.evaluate(settings, read) as Record<string, string | null>;
  if (Object.values(empty).some(value => value !== null)) throw new Error("卸载后原记忆仍存在，不能证明卸载成功");
  await rp.cdp.send("DOM.enable", {}, settings);
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: 0 }, settings) as { root: { nodeId: number } };
  const { nodeId } = await rp.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#memory-backup-file" }, settings) as { nodeId: number };
  await rp.cdp.send("DOM.setFileInputFiles", { nodeId, files: [path] }, settings);
  await until(() => rp!.evaluate(settings, 'document.querySelector("#memory-backup-status")?.textContent.includes("已恢复")'), 30_000, "恢复完成");
  const restored = await rp.evaluate(settings, read) as Record<string, string | null>;
  const pass = Object.entries(docs).every(([key, text]) => restored[key] === text);
  result = { browser, file: last.file, emptyAfterUninstall: true, downloadOwnerVerified: true, pass };
} catch (error) { result = { error: String(error), pass: false }; }
finally { await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2)); if (rp) { await rp.close(); await rp.remove(); } }
console.log(JSON.stringify({ ...result, out }));
if (!result.pass) process.exitCode = 1;
