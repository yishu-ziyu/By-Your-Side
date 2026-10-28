/** 两家隔离接收端：备用模型出错后，新密钥只能发给备用连接。 */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, sleep, watchInproc } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const changeDuringTest = process.argv.includes("--change-during-test");
const changeBeforeSave = process.argv.includes("--change-before-save");
const customStale = process.argv.includes("--custom-stale");
const customMain = process.argv.includes("--custom-main");
const fastModel = process.argv.includes("--fast-model");
const manualModel = process.argv.includes("--manual-model");
const reopen = process.argv.includes("--reopen");
const cookieCheck = process.argv.includes("--cookie-check");
const changeConversation = process.argv.includes("--change-conversation");
const changeAfterSave = process.argv.includes("--change-after-save");
const out = join(REPO, "out/acceptance/real-path", `key-recovery-binding-${randomUUID()}`);
await mkdir(out, { recursive: true });
const model = await startScriptedModel([{ match: "凭据隔离检查", steps: [{ text: "凭据隔离检查完成。" }] }]);
const seen: Array<{ target: string; key: string; task: boolean; cookie: boolean }> = [];
const front = (target: string) => createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  const key = String(req.headers.authorization ?? "");
  const task = /"tools"\s*:\s*\[\s*\{/.test(body);
  seen.push({ target, key, task, cookie: !!req.headers.cookie });
  if (target === "primary" && task && (!customMain || key !== "Bearer backup-new")) { res.writeHead(customStale || customMain ? 401 : 503, { "content-type": "application/json" }).end(customStale || customMain ? '{"error":{"message":"Invalid API key"}}' : '{"error":{"message":"Service Unavailable"}}'); return; }
  if (target === "backup" && key !== "Bearer backup-new" && key !== "Bearer backup-newer") { res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"Invalid API key"}}'); return; }
  if (target === "backup" && key === "Bearer backup-new" && !task && changeDuringTest) await sleep(2_000);
  const upstream = await fetch(`${model.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? body : undefined });
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
});
const primary = front("primary"), backup = front("backup");
await Promise.all([primary, backup].map(s => new Promise<void>(resolve => s.listen(0, "127.0.0.1", resolve))));
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let panel = "";
let logs: Awaited<ReturnType<typeof watchInproc>> | undefined;
let result: Record<string, unknown> = {};
let interceptError = "";
let automaticNewerRequests = 0;
let manualRetryCompleted = false;
try {
  rp = await launchRealPath();
  logs = await watchInproc(rp, rp.extensionId);
  const off = await until(async () => (await rp!.targets()).find(t => t.url === `chrome-extension://${rp!.extensionId}/inproc.html`), 30_000, "后台模型页");
  const session = await rp.attach(off.targetId);
  rp.cdp.onEvent("Fetch.requestPaused", (event: { sessionId?: string; params: { requestId: string; request: { url: string; method: string; headers: Record<string, string>; postData?: string } } }) => {
    if (event.sessionId !== session) return;
    const { requestId, request } = event.params;
    void (async () => {
      const path = new URL(request.url).pathname.replace(/^\/step_plan\/v1/, "/v1");
      const upstream = await fetch(`http://127.0.0.1:${siteAddress(backup).port}${path}`, { method: request.method, headers: { "content-type": "application/json", authorization: request.headers.Authorization ?? request.headers.authorization ?? "" }, body: request.postData });
      await rp!.cdp.send("Fetch.fulfillRequest", { requestId, responseCode: upstream.status, responseHeaders: [{ name: "content-type", value: upstream.headers.get("content-type") ?? "application/json" }, { name: "access-control-allow-origin", value: "*" }], body: Buffer.from(await upstream.arrayBuffer()).toString("base64") }, session);
    })().catch(e => { interceptError = String(e); });
  });
  await rp.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "https://api.stepfun.com/*", requestStage: "Request" }] }, session);
  panel = await rp.attach(await rp.openSidePanel());
  let otherWindow: string | undefined;
  const otherSettings = async () => {
    if (otherWindow) return otherWindow;
    const target = (await rp!.cdp.send("Target.createTarget", { url: `chrome-extension://${rp!.extensionId}/settings.html`, newWindow: true, background: true })).targetId as string;
    otherWindow = await rp!.attach(target);
    await until(() => rp!.evaluate(otherWindow!, '!!globalThis.chrome?.storage?.local && !!document.querySelector("#speed-test")').catch(() => false), 20_000, "另一设置窗口就绪");
    return otherWindow;
  };
  if (cookieCheck) await rp.cdp.send("Network.setCookie", { name: "local_fixture_cookie", value: "dummy", url: `http://127.0.0.1:${siteAddress(primary).port}/` }, panel);
  const config = { inproc_model_config: { provider: "custom", modelId: "primary-model", baseUrl: `http://127.0.0.1:${siteAddress(primary).port}/v1` }, inproc_backup_model_config: customStale || customMain || fastModel || manualModel ? null : { provider: "stepfun", modelId: "step-3.7-flash" }, ...(fastModel ? { inproc_fast_model_config: { provider: "stepfun", modelId: "step-3.7-flash" } } : {}), "inproc_cred:custom": { type: "api_key", key: "primary-key" }, "inproc_cred:stepfun": { type: "api_key", key: "backup-old" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(config)}).then(()=>true)`);
  await until(() => rp!.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  let earlierConversation = "";
  if (changeConversation) {
    earlierConversation = String(await rp.evaluate(panel, 'chrome.storage.local.get("selectedConversationId").then(s => s.selectedConversationId ?? "default")'));
    await rp.click(panel, "#conversation-new");
    await until(async () => String(await rp!.evaluate(panel, 'chrome.storage.local.get("selectedConversationId").then(s => s.selectedConversationId ?? "default")')) !== earlierConversation && await rp!.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled === false') || undefined, 15_000, "第二个会话就绪");
  }
  if (fastModel || manualModel) {
    await until(() => rp!.evaluate(panel, '!!document.querySelector("#think-chip") && !document.querySelector("#think-chip").hidden'), 20_000, "模型菜单就绪");
    await rp.click(panel, "#think-chip");
    await until(() => rp!.evaluate(panel, 'document.querySelector("#think-menu")?.classList.contains("open")'), 10_000, "模型菜单打开");
    const mainRow = '.mm-main .mm-row[data-model="stepfun/step-3.7-flash"]';
    if (await rp.evaluate(panel, `!!document.querySelector(${JSON.stringify(mainRow)})`)) await rp.click(panel, mainRow);
    else {
      await rp.click(panel, ".mm-more");
      await until(() => rp!.evaluate(panel, '!!document.querySelector(\'.mm-all .mm-row[data-model="stepfun/step-3.7-flash"]\')'), 15_000, "快速模型可选择");
      await rp.click(panel, '.mm-all .mm-row[data-model="stepfun/step-3.7-flash"]');
    }
    await until(() => rp!.evaluate(panel, 'document.querySelector("#think-chip")?.textContent.includes("step-3.7-flash")'), 15_000, "会话切到快速模型");
  }
  await rp.click(panel, "#input"); await rp.typeText(panel, "凭据隔离检查"); await rp.pressEnter(panel);
  await until(() => rp!.evaluate(panel, '!!document.querySelector(\'.error-card [data-act="fix-key"]\')'), 90_000, "模型认证错误");
  if (reopen) {
    const before = await rp.evaluate(panel, 'performance.timeOrigin');
    await rp.evaluate(panel, 'setTimeout(() => location.reload(), 0), true');
    await until(async () => await rp!.evaluate(panel, `performance.timeOrigin !== ${Number(before)} && !!document.querySelector('.error-card [data-act="fix-key"]')`).catch(() => false), 30_000, "重开侧栏后恢复错误卡");
  }
  if (customStale) {
    await sleep(500);
    await rp.evaluate(await otherSettings(), `chrome.storage.local.set({inproc_model_config:{provider:"custom",modelId:"primary-model",baseUrl:${JSON.stringify(`http://127.0.0.1:${siteAddress(backup).port}/v1`)}}}).then(()=>true)`);
    await sleep(500);
  }
  await rp.click(panel, '.error-card [data-act="fix-key"]');
  await until(() => rp!.evaluate(panel, '!!document.querySelector("#key-sheet.is-open")'), 10_000, "换密钥面板");
  await sleep(500);
  const label = String(await rp.evaluate(panel, 'document.querySelector(".key-sheet-model")?.textContent'));
  if (changeDuringTest || changeBeforeSave) await otherSettings();
  await rp.click(panel, "#key-sheet-input"); await rp.typeText(panel, "backup-new"); await rp.click(panel, "#key-sheet-test");
  const changeRole = async () => rp!.evaluate(await otherSettings(), `chrome.storage.local.set({inproc_fast_model_config:{provider:"stepfun",modelId:"step-3.7-flash"}}).then(()=>true)`);
  if (changeDuringTest) { await until(async () => seen.some(x => x.target === "backup" && x.key === "Bearer backup-new") || undefined, 10_000, "试连已到受控接收端"); await changeRole(); }
  const testStatus = await until(async () => { const s = String(await rp!.evaluate(panel, 'document.querySelector("#key-sheet-status")?.textContent')); return /连上|失败/.test(s) ? s : false; }, 30_000, "测试结果");
  const canSave = await rp.evaluate(panel, 'document.querySelector("#key-sheet-save")?.disabled===false');
  if (canSave === true) {
    if (customStale || changeBeforeSave) await changeRole();
    let lockSession: string | undefined;
    if (changeConversation) {
      const target = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html` })).targetId as string;
      lockSession = await rp.attach(target);
      await until(() => rp!.evaluate(lockSession!, '!!navigator.locks && !!document.querySelector("#speed-test")'), 20_000, "设置窗口就绪");
      await rp.evaluate(lockSession, `window.__keyLockHeld = false; window.__keyLockDone = new Promise(r => window.__releaseKeyLock = r); navigator.locks.request('settings-model-configuration', () => { window.__keyLockHeld = true; return window.__keyLockDone; }); true`);
      await until(() => rp!.evaluate(lockSession!, 'window.__keyLockHeld === true'), 10_000, "另一窗口持有设置锁");
    }
    let paused = false;
    let workerSession: string | undefined;
    if (changeAfterSave) {
      console.log("after-save: preparing breakpoint");
      const worker = await rp.serviceWorker();
      if (!worker) throw new Error("扩展后台不可用");
      workerSession = await rp.attach(worker.targetId);
      rp.cdp.onEvent("Debugger.paused", (event: { sessionId?: string }) => { if (event.sessionId === panel) paused = true; });
      await rp.cdp.send("Debugger.enable", {}, panel);
      const source = await readFile(join(REPO, "extension/dist/sidepanel.js"), "utf8");
      const lineNumber = source.split("\n").findIndex(line => line.includes("recover(") && line.includes(", key, false, target)"));
      if (lineNumber < 0) throw new Error("找不到保存后继续的位置");
      await rp.cdp.send("Debugger.setBreakpointByUrl", { url: `chrome-extension://${rp.extensionId}/sidepanel.js`, lineNumber }, panel);
    }
    await rp.click(panel, "#key-sheet-save");
    if (changeAfterSave) {
      console.log("after-save: waiting for breakpoint");
      await until(async () => paused || undefined, 15_000, "保存后、重试前暂停");
      console.log("after-save: breakpoint hit, changing key");
      if (!workerSession) throw new Error("扩展后台不可用");
      await rp.evaluate(workerSession, `navigator.locks.request('settings-model-configuration', () => chrome.storage.local.set({'inproc_cred:stepfun':{type:'api_key',key:'backup-newer'}})).then(()=>true)`);
      await sleep(1_000);
      await rp.cdp.send("Debugger.resume", {}, panel);
      console.log("after-save: resumed");
    }
    if (changeConversation && lockSession) {
      await rp.click(panel, "#conversation-switcher");
      await rp.click(panel, `[data-conversation-id="${earlierConversation}"]`);
      await until(() => rp!.evaluate(panel, '!document.querySelector("#messages")?.textContent.includes("凭据隔离检查")'), 10_000, "切换到另一个会话");
      await rp.evaluate(lockSession, 'window.__releaseKeyLock(), true');
      await sleep(1_500);
    } else if (customStale || changeBeforeSave) await until(() => rp!.evaluate(panel, 'document.querySelector("#key-sheet-status")?.textContent.includes("无法确认密钥是否保存")'), 10_000, "变化后拒绝保存");
    else if (changeAfterSave) {
      await sleep(1_500);
      automaticNewerRequests = seen.filter(x => x.target === "backup" && x.key === "Bearer backup-newer" && x.task).length;
      if (automaticNewerRequests === 0) {
        await until(() => rp!.evaluate(panel, 'document.querySelector("#messages")?.textContent.includes("原模型连接已变化，没有继续")'), 10_000, "凭据变化后停止继续");
        await rp.click(panel, '.error-card [data-act="retry-anyway"]');
        await until(() => rp!.evaluate(panel, 'document.querySelector("#messages")?.textContent.includes("凭据隔离检查完成。")'), 45_000, "用户主动重试可继续");
        manualRetryCompleted = true;
      }
    }
    else await until(() => rp!.evaluate(panel, 'document.querySelector("#messages")?.textContent.includes("凭据隔离检查完成。")'), 45_000, "原任务恢复并回答");
  }
  const stored = await rp.evaluate(panel, `chrome.storage.local.get(["inproc_cred:custom", "inproc_cred:stepfun"]).then(s => ({ primary: s["inproc_cred:custom"]?.key === "primary-key", primaryNew: s["inproc_cred:custom"]?.key === "backup-new", backup: s["inproc_cred:stepfun"]?.key === "backup-new", backupNewer: s["inproc_cred:stepfun"]?.key === "backup-newer" }))`) as { primary: boolean; primaryNew: boolean; backup: boolean; backupNewer: boolean };
  let speedRequested = false;
  if (cookieCheck && customMain) {
    const settingsTarget = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html#models` })).targetId as string;
    const settings = await rp.attach(settingsTarget);
    await until(() => rp!.evaluate(settings, '!!document.querySelector("#speed-test") && !document.querySelector("#speed-test").disabled'), 30_000, "设置测速就绪");
    const beforeSpeed = seen.length;
    await rp.click(settings, "#speed-test");
    await until(async () => seen.length > beforeSpeed || undefined, 30_000, "测速请求到达受控服务端");
    speedRequested = true;
    await until(() => rp!.evaluate(settings, '!document.querySelector("#speed-test").disabled'), 30_000, "测速结束");
  }
  const wrong = seen.filter(x => x.target === "primary" && x.key === "Bearer backup-new").length;
  const right = seen.filter(x => x.target === "backup" && x.key === "Bearer backup-new").length;
  const resumed = seen.filter(x => x.target === "backup" && x.key === "Bearer backup-new" && x.task).length;
  const changed = changeDuringTest || changeBeforeSave || changeConversation;
  const pass = customStale ? label.includes("custom") && right === 0 && stored.primary && !stored.backup && resumed === 0
    : customMain ? label.includes("custom") && right === 0 && wrong > 0 && canSave === true && stored.primaryNew && !stored.backup && seen.some(x => x.target === "primary" && x.key === "Bearer backup-new" && x.task)
    : label.includes("stepfun") && wrong === 0 && right > 0 && (changeAfterSave ? resumed === 0 && stored.primary && stored.backupNewer && automaticNewerRequests === 0 && manualRetryCompleted && seen.some(x => x.target === "backup" && x.key === "Bearer backup-newer" && x.task)
      : changed ? resumed === 0 && stored.primary && !stored.backup && (changeBeforeSave || changeConversation ? canSave === true : canSave === false) : resumed === 1 && canSave === true && stored.primary && stored.backup);
  const cookies = seen.filter(x => x.cookie).length;
  result = { label, wrong, right, resumed, automaticNewerRequests, manualRetryCompleted, canSave, stored, changed, customStale, cookies, speedRequested, testStatus, interceptError, pass: pass && !interceptError && (!changeDuringTest || testStatus.includes("测试期间连接已变化")) && (!cookieCheck || cookies === 0 && (!customMain || speedRequested)) };
} catch (e) {
  if (rp && panel && changeAfterSave) await rp.cdp.send("Debugger.resume", {}, panel).catch(() => undefined);
  const ui = rp && panel ? await rp.evaluate(panel, `({messages: document.querySelector('#messages')?.innerText.slice(-500), sheet: document.querySelector('#key-sheet-status')?.innerText, newDisabled: document.querySelector('#conversation-new')?.disabled})`).catch(() => null) : null;
  result = { ...result, error: String(e), ui, pass: false };
}
finally {
  if (rp && panel) await sleep(1_000);
  if (rp && panel) await rp.screenshot(panel, join(out, "sidepanel.png")).catch(() => undefined);
  if (logs) await writeFile(join(out, "inproc.log"), logs.logs());
  await writeFile(join(out, "result.json"), JSON.stringify({ ...result, received: seen.map(({ target, key, task, cookie }) => ({ target, key: key === "Bearer backup-new" ? "new" : key === "Bearer primary-key" ? "primary" : key === "Bearer backup-old" ? "old" : key === "Bearer backup-newer" ? "newer" : "other", task, cookie })) }, null, 2));
  if (rp) { await rp.close(); await rp.remove(); }
  await model.close(); for (const s of [primary, backup]) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); }
}
console.log(JSON.stringify({ ...result, out }));
if (!result.pass) process.exitCode = 1;
