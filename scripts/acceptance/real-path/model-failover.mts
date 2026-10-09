/**
 * 主模型卡住或暂时出错时，换设置页「备用模型」里选的另一家接着做（docs/evals/20261009-model-backup.md R1）。
 * 只装扩展、隔离构建、本机脚本模型：主模型是自定义地址，指向本机服务（挂起 / 回 503 / 回 401）；
 * 备用模型是阶跃星辰，发往 api.stepfun.com 的请求在 offscreen 文档里被 CDP 拦下，转给本机脚本模型回答。
 *   npx tsx scripts/acceptance/real-path/model-failover.mts --headless [--case=hang|503|401|quota|off|stop]
 * stop（R2）：主模型回 503，换模型那次写盘被拖慢，期间点「停」；备用模型不能收到任务请求。
 * return（R1 末句）：换到备用后，不满 5 分钟的下一条仍走备用；把扩展内 agent 的时钟往后拨 5 分钟（只改 Date.now，不碰产品代码），
 *   下一条先问主模型（仍回 503，于是再换备用），侧栏写「已换回」。
 * 每个用例单独启动一次 Chrome，证据各写一个目录。
 * 失败方式：侧栏一直等主模型；或报错而不是换备用；或 401、额度用尽也换了；或「不用备用」时也换了；或侧栏看不到切换。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const MARK = "你好，切换验收";

const ANSWER = "你好！我是备用模型，在这儿。";

const BOUND_MS = 25_000;

const BACKUP = { provider: "stepfun", modelId: "step-3.7-flash" };

type Primary = "hang" | { status: number; body: string };

type Case = { name: string; primary: Primary; backup: boolean; stopAfterMs?: number; slowSwitchMs?: number; switchBack?: boolean };

const UNAVAILABLE = { status: 503, body: JSON.stringify({ error: { message: "Service Unavailable", type: "server_error" } }) };

const CASES: Case[] = [
  { name: "hang", primary: "hang", backup: true },
  { name: "503", primary: { status: 503, body: JSON.stringify({ error: { message: "Service Unavailable", type: "server_error" } }) }, backup: true },
  { name: "401", primary: { status: 401, body: JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }) }, backup: true },
  // 额度用尽常带 429，但不是「忙」：只报原因，不换。
  { name: "quota", primary: { status: 429, body: JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } }) }, backup: true },
  { name: "return", primary: UNAVAILABLE, backup: true, switchBack: true },
  { name: "off", primary: { status: 503, body: JSON.stringify({ error: { message: "Service Unavailable", type: "server_error" } }) }, backup: false },
    // 「停」从侧栏到 agent 要上百毫秒，比换模型那段时间长（只靠点击时机，8 次一次也没碰到）；
  // 像磁盘慢一样把换模型记录的写盘拖 1.5 秒，让「停」稳定落在途中。
  ...[0, 1, 2].map(i => ({ name: `stop-${i}`, primary: UNAVAILABLE, backup: true, stopAfterMs: 300, slowSwitchMs: 1_500 })),
];

const only = process.argv.find(a => a.startsWith("--case="))?.slice("--case=".length);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const summary: Array<{ name: string; status: string; artifacts: string; error: string | null; raceHit?: unknown }> = [];

for (const c of CASES.filter(c => !only || c.name === only || c.name.startsWith(`${only}-`))) summary.push(await runCase(c));

console.log(JSON.stringify(summary, null, 2));

const stops = summary.filter(s => s.name.startsWith("stop-"));

if (stops.length) console.log(`stop：${stops.length} 次里有 ${stops.filter(s => s.raceHit === true).length} 次「停」落在换模型途中`);

// stop 用例一次都没碰到换模型途中，就没有验到 R2，不算通过。
if (summary.some(s => s.status !== "PASS") || (stops.length && !stops.some(s => s.raceHit === true))) process.exitCode = 1;

async function runCase(c: Case) {
  const artifacts = join(REPO, "out/acceptance/real-path", `${stamp}-model-failover-${c.name}`);

  await mkdir(artifacts, { recursive: true });
  const backup = await startScriptedModel([{ match: MARK, steps: [{ text: ANSWER }] }]);
  // 主模型：带工具表的任务请求按用例挂起或回错误码；其他请求（不带工具的内部判断）转给脚本模型。
  const primaryAsked: number[] = [];
  /** stop 用例：主模型回 503 之后点「停」，记下时间。 */
  let pressStop: (() => void) | undefined;

  const main = createServer(async (req, res) => {
    let body = "";

    for await (const chunk of req) body += String(chunk);

    if (req.method === "POST" && /"tools"\s*:\s*\[\s*\{/.test(body)) {
      primaryAsked.push(Date.now());

      if (c.primary === "hang") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();

        return;
      }

      res.writeHead(c.primary.status, { "content-type": "application/json" }).end(c.primary.body);

      if (c.stopAfterMs !== undefined) setTimeout(() => pressStop?.(), c.stopAfterMs);

      return;
    }

    const upstream = await fetch(`${backup.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? body : undefined });
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
  });

  await new Promise<void>(resolve => main.listen(0, "127.0.0.1", resolve));
  const rp = await launchRealPath();
  /** 发往阶跃星辰（备用模型）的请求：带不带工具表、各自的时间。 */
  const backupAsked: Array<{ at: number; tools: boolean }> = [];
  let error: string | null = null;
  const evidence: Record<string, unknown> = { case: c.name };

  try {
    // 备用模型是另一家服务商：在 offscreen 文档里拦下发往阶跃星辰的请求，转给本机脚本模型。
    const offscreen = await until(async () => (await rp.targets()).find(t => t.url === `chrome-extension://${rp.extensionId}/inproc.html`), 30_000, "扩展内 agent 的 offscreen 文档");
    const offscreenSession = await rp.attach(offscreen.targetId);

    rp.cdp.onEvent("Fetch.requestPaused", (message: { sessionId?: string; params: { requestId: string; request: { url: string; method: string; postData?: string } } }) => {
      if (message.sessionId !== offscreenSession) return;
      const { requestId, request } = message.params;
      const path = new URL(request.url).pathname.replace(/^\/step_plan\/v1/, "");
      backupAsked.push({ at: Date.now(), tools: /"tools"\s*:\s*\[\s*\{/.test(request.postData ?? "") });
      void (async () => {
        const upstream = await fetch(`${backup.baseUrl.replace(/\/$/, "")}${path}`, { method: request.method, headers: { "content-type": "application/json" }, body: request.postData });
        const body = Buffer.from(await upstream.arrayBuffer()).toString("base64");
        await rp.cdp.send("Fetch.fulfillRequest", { requestId, responseCode: upstream.status, responseHeaders: [{ name: "content-type", value: upstream.headers.get("content-type") ?? "application/json" }, { name: "access-control-allow-origin", value: "*" }], body }, offscreenSession);
      })().catch(caught => { evidence.interceptError = String(caught); });
    });
    await rp.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "https://api.stepfun.com/*", requestStage: "Request" }] }, offscreenSession);

    if (c.stopAfterMs !== undefined) {
      // 证人：在扩展内 agent 调切换提示那一行设一个不暂停的条件断点，记下那时有没有已经点了「停」。
      // 切换提示之后同步接着让备用模型开始，所以这里看到「已停」，就是「停」落在换模型途中。产品代码里没有为测试加的东西。
      const scripts: Array<{ scriptId: string; url: string }> = [];
      rp.cdp.onEvent("Debugger.scriptParsed", (message: { sessionId?: string; params: { scriptId: string; url: string } }) => {
        if (message.sessionId === offscreenSession) scripts.push(message.params);
      });
      await rp.cdp.send("Debugger.enable", {}, offscreenSession);
      const script = await until(async () => scripts.find(s => s.url.endsWith("/inproc.js")), 10_000, "inproc.js 已加载");
      const { scriptSource } = await rp.cdp.send("Debugger.getScriptSource", { scriptId: script.scriptId }, offscreenSession) as { scriptSource: string };
      const lines = scriptSource.split("\n");
      const lineNumber = lines.findIndex(line => line.includes("this.onSwitch(from, to, \"fallback\");"));
      assert.ok(lineNumber >= 0, "找到切换提示那一行");

      if (c.slowSwitchMs) {
        // 只拖慢这一次换模型记录的写盘（测试从外面经调试器做，产品代码不变）。
        const write = lines.findIndex(line => line.includes('appendCustomEntry("sideagent-model-fallback-v1"'));
        assert.ok(write >= 0, "找到换模型记录那一行");
        await rp.cdp.send("Debugger.setBreakpoint", { location: { scriptId: script.scriptId, lineNumber: write, columnNumber: lines[write]!.search(/\S/) }, condition: `(() => { const sm = this.inner.sessionManager; const write = sm.appendCustomEntry; sm.appendCustomEntry = (...a) => { sm.appendCustomEntry = write; return new Promise(r => setTimeout(r, ${c.slowSwitchMs})).then(() => write.apply(sm, a)); }; })(), false` }, offscreenSession);
      }

      await rp.cdp.send("Debugger.setBreakpoint", { location: { scriptId: script.scriptId, lineNumber, columnNumber: lines[lineNumber]!.indexOf("this.onSwitch") }, condition: "(globalThis.__r2 = { at: Date.now(), stopped: this.stopped }), false" }, offscreenSession);
    }

    const panel = await rp.attach(await rp.openSidePanel());
    await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);

    // 主模型与两家凭据直接写入（设置页填 key 另有验收 inproc-config）；备用模型像用户一样在设置页「备用模型」里选。
    const items = {
      inproc_model_config: { provider: "custom", modelId: "primary-model", baseUrl: `http://127.0.0.1:${siteAddress(main).port}/v1` },
      "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
      "inproc_cred:stepfun": { type: "api_key", key: "local-demo-no-secret" },
    };

    await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);

    evidence.stage = "settings";
    const settingsTarget = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html` })).targetId as string;
    const settings = await rp.attach(settingsTarget);
    const optionValue = JSON.stringify(BACKUP);
    await until(async () => await rp.evaluate(settings, `[...document.querySelectorAll("#backup-model option")].some(o => o.value === ${JSON.stringify(optionValue)})`) || undefined, 20_000, "备用模型列出阶跃星辰");
    const row = await rp.evaluate(settings, `(() => { const s = document.querySelector("#backup-model"); return { value: s.value, selectedText: s.selectedOptions[0]?.textContent, groups: [...s.querySelectorAll("optgroup")].map(g => g.label) }; })()`) as { value: string; selectedText: string; groups: string[] };
    evidence.settingsRowBefore = row;
    assert.equal(row.value, "", "备用模型默认是「不用备用」");
    assert.equal(row.selectedText, "不用备用");
    assert.ok(row.groups.every(label => /阶跃星辰/.test(label)), `只列已填 key 的服务商（看到 ${row.groups.join("、")}）`);

    if (c.backup) {
      await rp.evaluate(settings, `(() => { const s = document.querySelector("#backup-model"); s.value = ${JSON.stringify(optionValue)}; s.dispatchEvent(new Event("change")); return true; })()`);
      await until(async () => await rp.evaluate(panel, `chrome.storage.local.get("inproc_backup_model_config").then(s => s.inproc_backup_model_config?.provider === "stepfun")`) || undefined, 5_000, "备用模型已保存");
      evidence.settingsStatus = await rp.evaluate(settings, `document.querySelector("#backup-status").textContent`);
      await rp.screenshot(settings, join(artifacts, "settings.png"));
    }

    evidence.stage = "send";
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
    await rp.click(panel, "#input");
    await rp.typeText(panel, MARK);
    const sentAt = Date.now();
    await rp.pressEnter(panel);

    let stopAt: number | undefined;
    pressStop = () => {
      stopAt = Date.now();
      void rp.evaluate(panel, `(() => { const b = document.querySelector("#send-btn"); const stopping = b.classList.contains("stopping"); if (stopping) b.click(); return stopping; })()`).then(clicked => { evidence.stopClicked = clicked; });
    };
    const messages = () => rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""').then(String);

    if (c.stopAfterMs !== undefined) {
      await until(async () => stopAt !== undefined && await rp.evaluate(panel, '!document.querySelector("#send-btn").classList.contains("stopping")') || undefined, 30_000, "sidebar idle after stop");
      // 停下后再等 5 秒，看备用模型有没有迟到的请求。
      await new Promise(resolve => setTimeout(resolve, 5_000));
    } else if (c.name === "hang" || c.name === "503" || c.switchBack) {
      await until(async () => (await messages()).includes(ANSWER) || undefined, 90_000, "answer visible");
    } else {
      await until(async () => await rp.evaluate(panel, '!!document.querySelector("#messages .error-card")') || undefined, 120_000, "error card visible");
    }

    const visibleMs = Date.now() - sentAt;
    evidence.stage = "done";
    const text = await messages();
    await rp.screenshot(panel, join(artifacts, "sidebar.png"));
    const taskToBackup = backupAsked.filter(r => r.tools);
    Object.assign(evidence, {
      visibleMs,
      primaryAskedAtMs: primaryAsked.map(at => at - sentAt),
      backupTaskRequestsAtMs: taskToBackup.map(r => r.at - sentAt),
      switchNotice: text.match(/[^。]*切换到[^。]*。/)?.[0] ?? null,
      sidebarTail: text.slice(-400),
    });

    if (c.switchBack) {
      const answers = async () => (await messages()).split(ANSWER).length - 1;
      const sendAgain = async (n: number) => {
        await until(async () => await rp.evaluate(panel, '!document.querySelector("#send-btn").classList.contains("stopping") && document.querySelector("#send-btn").disabled === false') || undefined, 30_000, "sidebar idle");
        await rp.click(panel, "#input");
        await rp.typeText(panel, MARK);
        const at = Date.now();
        await rp.pressEnter(panel);
        await until(async () => await answers() >= n || undefined, 90_000, `第 ${n} 个回答出现`);

        return at;
      };
      assert.equal(primaryAsked.length, 1, "第一条：主模型只被问一次");
      // 不满 5 分钟：下一条仍走备用，主模型不被问。
      const secondAt = await sendAgain(2);
      evidence.second = { primaryAsked: primaryAsked.filter(at => at >= secondAt).length, backupTask: backupAsked.filter(r => r.tools && r.at >= secondAt).length };
      assert.equal(primaryAsked.length, 1, "不满 5 分钟，下一条不问主模型");
      assert.ok(backupAsked.some(r => r.tools && r.at >= secondAt), "不满 5 分钟，下一条由备用回答");
      assert.ok(!(await messages()).includes("已换回"), "不满 5 分钟，没有「已换回」");
      // 侧栏空闲时把扩展内 agent 的时钟拨后 5 分钟（像真过了 5 分钟），产品照常读 Date.now。
      await rp.evaluate(offscreenSession, "(() => { const real = Date.now.bind(Date); Date.now = () => real() + 5 * 60_000 + 1_000; return true; })()");
      const thirdAt = await sendAgain(3);
      const primaryThird = primaryAsked.filter(at => at >= thirdAt);
      const backupThird = backupAsked.filter(r => r.tools && r.at >= thirdAt);
      const text = await messages();
      evidence.third = { primaryAtMs: primaryThird.map(at => at - thirdAt), backupTaskAtMs: backupThird.map(r => r.at - thirdAt), returnNotice: text.match(/已换回[^。]*。/)?.[0] ?? null };
      assert.equal(primaryThird.length, 1, "满 5 分钟后的下一条先问主模型");
      assert.ok(backupThird.length >= 1 && backupThird.every(r => r.at >= primaryThird[0]!), "主模型又出错，之后才换回备用");
      assert.match(text, /已换回 .*primary-model/, "侧栏写明换回了主模型");
      assert.equal(text.match(/切换到 阶跃星辰/g)?.length, 2, "主模型再出错时又换到备用");
      await rp.screenshot(panel, join(artifacts, "sidebar-after-return.png"));
    }

    if (c.stopAfterMs !== undefined) {
      evidence.stopAtMs = stopAt! - sentAt;
      evidence.idle = await rp.evaluate(panel, '!document.querySelector("#send-btn").classList.contains("stopping")');
      const witness = await rp.evaluate(offscreenSession, "globalThis.__r2 ?? null") as { at: number; stopped: boolean } | null;
      evidence.switchWitness = witness && { atMs: witness.at - sentAt, stopped: witness.stopped };
      // 没走到切换（「停」落在换模型之前）或走到时还没停（「停」落在备用开始之后），这一次都没碰到 R2 的那段时间。
      evidence.raceHit = witness?.stopped === true;
      assert.equal(evidence.idle, true, "侧栏停下了");
      assert.ok(!text.includes(ANSWER), "没有备用模型的回答");

      if (evidence.raceHit) assert.equal(taskToBackup.length, 0, "换模型途中点了「停」，备用模型没有收到任务请求");
    } else if (c.name === "hang" || c.name === "503") {
      assert.equal(primaryAsked.length, 1, "主模型只被问一次，不在原模型上重试");
      assert.ok(taskToBackup.length >= 1, "备用模型（阶跃星辰）收到了任务请求");
      assert.ok(visibleMs <= (c.name === "503" ? 10_000 : BOUND_MS), `回答在时限内出现（${visibleMs} ms）`);
      assert.match(text, /已由 .*primary-model 切换到 阶跃星辰 · step-3\.7-flash/, "侧栏写明从谁换成了谁");
    } else if (!c.switchBack) {
      assert.equal(taskToBackup.length, 0, "没有换到备用模型");
      assert.ok(!/切换到/.test(text), "侧栏没有切换提示");
      assert.ok(!text.includes(ANSWER), "没有备用模型的回答");
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  } finally {
    const status = error ? "FAIL" : "PASS";
    await writeFile(join(artifacts, "result.json"), JSON.stringify({ status, evidence, error }, null, 2));
    await rp.close();
    await rp.remove();
    await backup.close();
    main.closeAllConnections();
    main.close();
  }

  return { name: c.name, status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null, ...(c.stopAfterMs !== undefined ? { raceHit: evidence.raceHit ?? null, backupTaskRequests: evidence.backupTaskRequestsAtMs ?? null } : {}) };
}
