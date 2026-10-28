/** 隔离扩展：写入后后台重启，欠下的备份仍能落盘。 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, until } from "./harness.mts";

requireHeadless();
const downloadFailure = process.argv.includes("--download-failure");
const out = join(REPO, "out/acceptance/real-path", `memory-backup-pending-${randomUUID()}`);
await mkdir(out, { recursive: true });
const memories = JSON.stringify({ entries: [{ id: "backup-fixture", status: "active", text: "隔离备份内容" }] });
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let result: Record<string, unknown> = {};
try {
  rp = await launchRealPath();
  const target = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html#data` })).targetId as string;
  let settings = await rp.attach(target);
  await until(() => rp!.evaluate(settings, '!!document.querySelector("#memory-backup-status")').catch(() => false), 30_000, "设置就绪");
  const worker = await rp.serviceWorker(); if (!worker) throw new Error("扩展后台不可用");
  await rp.evaluate(settings, `new Promise((resolve,reject)=>{const q=indexedDB.open('sideagent-memory',1);q.onerror=()=>reject(q.error);q.onsuccess=()=>{const db=q.result,tx=db.transaction('kv','readwrite'),s=tx.objectStore('kv');s.put(${JSON.stringify(memories)},'memories');s.put('fixture-pending','memory-backup-dirty-v1');tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error)}})`);
  if (!downloadFailure) {
  await rp.evaluate(settings, 'chrome.storage.local.set({memory_backup_ui_disabled:true}).then(()=>chrome.downloads.setUiOptions({enabled:false})).then(()=>true)');
  await rp.evaluate(settings, 'setTimeout(()=>chrome.runtime.reload(),0), true');
  await until(async () => { const next = await rp!.serviceWorker(); return next && next.targetId !== worker.targetId ? next : false; }, 30_000, "后台重启");
  const next = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html#data` })).targetId as string;
  settings = await rp.attach(next);
  await until(() => rp!.evaluate(settings, '!!globalThis.chrome?.storage?.local').catch(() => false), 30_000, "设置重新就绪");
  }
  let failedAt: number | null = null;
  if (downloadFailure) {
    await rp.evaluate(settings, 'chrome.runtime.sendMessage({type:"acceptance-wake"}).catch(()=>null)');
    const currentWorker = await until(() => rp!.serviceWorker(), 10_000, "故障注入后台目标");
    if (!currentWorker) throw new Error("重启后的后台不可用");
    const background = await rp.attach(currentWorker.targetId);
    await rp.cdp.send("Runtime.enable", {}, background);
    console.log("故障注入目标", JSON.stringify(await rp.evaluate(background, '({url:location.href,id:chrome.runtime?.id,download:typeof chrome.downloads?.download})')));
    await until(() => rp!.evaluate(background, 'typeof chrome.downloads?.download === "function"'), 5_000, "后台下载接口就绪");
    await rp.evaluate(background, `(()=>{const original=chrome.downloads.download.bind(chrome.downloads);let fail=true;chrome.downloads.download=function(options){if(fail){fail=false;return Promise.reject(new Error('fixture-download-failure'))}return original(options)};return true})()`);
    await rp.evaluate(settings, 'chrome.runtime.sendMessage({type:"memory_backup_changed"}).catch(()=>null)');
    await until(() => rp!.evaluate(settings, 'chrome.storage.local.get("memory_backup_error").then(s=>!!s.memory_backup_error)'), 20_000, "下载失败被记录");
    failedAt = Date.now();
    await until(() => rp!.evaluate(settings, 'document.querySelector("#memory-backup-desc")?.textContent.includes("备份未完成")'), 5_000, "设置显示失败与重试提示");
    const state = await rp.evaluate(settings, 'chrome.storage.local.get(["memory_backup_retry","memory_backup_last","memory_backup_ui_disabled"])') as Record<string, unknown>;
    if (state.memory_backup_last || state.memory_backup_ui_disabled) throw new Error("失败被记成成功或下载界面未恢复");
  }
  const last = await until(async () => await rp!.evaluate(settings, 'chrome.storage.local.get("memory_backup_last").then(s=>s.memory_backup_last ?? null)') as { file?: string } | null, downloadFailure ? 50_000 : 20_000, "欠下的备份落盘");
  if (!last.file) throw new Error("备份未记录文件名");
  const saved: unknown = JSON.parse(await readFile(join(rp.dirs.downloads, last.file), "utf8"));
  const doc = saved && typeof saved === "object" && "documents" in saved && saved.documents && typeof saved.documents === "object" && "memories" in saved.documents ? saved.documents.memories : undefined;
  const recovered = await rp.evaluate(settings, 'chrome.storage.local.get(["memory_backup_error","memory_backup_retry","memory_backup_ui_disabled"])') as Record<string, unknown>;
  const retryDelay = failedAt === null ? null : Date.now() - failedAt;
  const cleared = !recovered.memory_backup_error && !recovered.memory_backup_retry && !recovered.memory_backup_ui_disabled;
  result = { file: last.file, matched: doc === memories, downloadFailure, retryDelay, cleared, pass: doc === memories && cleared && (retryDelay === null || retryDelay >= 25_000) };
} catch (error) { result = { error: String(error), pass: false }; }
finally { await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2)); if (rp) { await rp.close(); await rp.remove(); } }
console.log(JSON.stringify({ ...result, out }));
if (!result.pass) process.exitCode = 1;
