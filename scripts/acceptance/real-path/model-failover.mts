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

type Case = { name: string; primary: Primary; backup: boolean; stopAfterMs?: number; slowSwitchMs?: number; switchBack?: boolean; side?: boolean };

const REMEMBER = "记住我住在北京";

const TASK_REPLY = "好的，这句我记下了。";

const SAVE_DECISION = { action: "save", text: "住在北京", evidence: REMEMBER, scope: { kind: "all" }, targets: [], taskRequested: false, about: { longTerm: true, date: null, onlyThisTask: false, explicitRequest: true } };

const UNAVAILABLE = { status: 503, body: JSON.stringify({ error: { message: "Service Unavailable", type: "server_error" } }) };

const CASES: Case[] = [
  { name: "hang", primary: "hang", backup: true },
  { name: "503", primary: { status: 503, body: JSON.stringify({ error: { message: "Service Unavailable", type: "server_error" } }) }, backup: true },
  { name: "401", primary: { status: 401, body: JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }) }, backup: true },
  { name: "quota", primary: { status: 429, body: JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } }) }, backup: true },
  { name: "return", primary: UNAVAILABLE, backup: true, switchBack: true },
  { name: "off", primary: { status: 503, body: JSON.stringify({ error: { message: "Service Unavailable", type: "server_error" } }) }, backup: false },
  ...[0, 1, 2].map(i => ({ name: `stop-${i}`, primary: UNAVAILABLE, backup: true, stopAfterMs: 300, slowSwitchMs: 1_500 })),
  { name: "side503", primary: UNAVAILABLE, backup: true, side: true },
  { name: "side401", primary: { status: 401, body: JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }) }, backup: true, side: true },
];

const only = process.argv.find(a => a.startsWith("--case="))?.slice("--case=".length);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const summary: Array<{ name: string; status: string; artifacts: string; error: string | null; raceHit?: unknown }> = [];

for (const c of CASES.filter(c => !only || c.name === only || c.name.startsWith(`${only}-`))) summary.push(await runCase(c));

console.log(JSON.stringify(summary, null, 2));

const stops = summary.filter(s => s.name.startsWith("stop-"));

if (stops.length) console.log(`stop：${stops.length} 次里有 ${stops.filter(s => s.raceHit === true).length} 次「停」落在换模型途中`);

if (summary.some(s => s.status !== "PASS") || (stops.length && !stops.some(s => s.raceHit === true))) process.exitCode = 1;

async function runCase(c: Case) {
  const artifacts = join(REPO, "out/acceptance/real-path", `${stamp}-model-failover-${c.name}`);

  await mkdir(artifacts, { recursive: true });
  const backup = await startScriptedModel(c.side ? [{ match: REMEMBER, steps: [{ text: JSON.stringify(SAVE_DECISION) }] }] : [{ match: MARK, steps: [{ text: ANSWER }] }]);
  const task = c.side ? await startScriptedModel([{ match: REMEMBER, steps: [{ text: TASK_REPLY }] }]) : backup;
  const forward = async (to: { baseUrl: string }, url: string | undefined, method: string | undefined, body: string) =>
    fetch(`${to.baseUrl.replace(/\/$/, "")}${(url ?? "").replace(/^\/v1/, "")}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? body : undefined });
  const sideFailed: number[] = [];
  const primaryAsked: number[] = [];
  let pressStop: (() => void) | undefined;

  const main = createServer(async (req, res) => {
    let body = "";

    req.setEncoding('utf8'); for await (const chunk of req) body += chunk;

    const tools = /"tools"\s*:\s*\[\s*\{/.test(body);

    if (c.side && req.method === "POST" && c.primary !== "hang") {
      if (!tools) {
        sideFailed.push(Date.now());
        res.writeHead(c.primary.status, { "content-type": "application/json" }).end(c.primary.body);

        return;
      }

      const upstream = await forward(task, req.url, req.method, body);
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));

      return;
    }

    if (req.method === "POST" && tools) {
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

    const upstream = await forward(backup, req.url, req.method, body);
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
  });

  await new Promise<void>(resolve => main.listen(0, "127.0.0.1", resolve));
  const rp = await launchRealPath();
  const backupAsked: Array<{ at: number; tools: boolean }> = [];
  let error: string | null = null;
  const evidence: Record<string, unknown> = { case: c.name };

  try {
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
        const write = lines.findIndex(line => line.includes('appendCustomEntry("sideagent-model-fallback-v1"'));
        assert.ok(write >= 0, "找到换模型记录那一行");
        await rp.cdp.send("Debugger.setBreakpoint", { location: { scriptId: script.scriptId, lineNumber: write, columnNumber: lines[write]!.search(/\S/) }, condition: `(() => { const sm = this.inner.sessionManager; const write = sm.appendCustomEntry; sm.appendCustomEntry = (...a) => { sm.appendCustomEntry = write; return new Promise(r => setTimeout(r, ${c.slowSwitchMs})).then(() => write.apply(sm, a)); }; })(), false` }, offscreenSession);
      }

      await rp.cdp.send("Debugger.setBreakpoint", { location: { scriptId: script.scriptId, lineNumber, columnNumber: lines[lineNumber]!.indexOf("this.onSwitch") }, condition: "(globalThis.__r2 = { at: Date.now(), stopped: this.stopped }), false" }, offscreenSession);
    }

    const panel = await rp.attach(await rp.openSidePanel());
    await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);

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
    assert.deepEqual(row.groups.toSorted(), ["阶跃星辰", "自定义地址"].toSorted(), "只列本用例已配置的两个服务商");

    if (c.backup) {
      await rp.evaluate(settings, `(() => { const s = document.querySelector("#backup-model"); s.value = ${JSON.stringify(optionValue)}; s.dispatchEvent(new Event("change")); return true; })()`);
      await until(async () => await rp.evaluate(panel, `chrome.storage.local.get("inproc_backup_model_config").then(s => s.inproc_backup_model_config?.provider === "stepfun")`) || undefined, 5_000, "备用模型已保存");
      evidence.settingsStatus = await rp.evaluate(settings, `document.querySelector("#backup-status").textContent`);
      await rp.screenshot(settings, join(artifacts, "settings.png"));
    }

    evidence.stage = "send";
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
    await rp.click(panel, "#input");
    await rp.typeText(panel, c.side ? REMEMBER : MARK);
    const sentAt = Date.now();
    await rp.pressEnter(panel);

    let stopAt: number | undefined;
    pressStop = () => {
      stopAt = Date.now();
      void rp.evaluate(panel, `(() => { const b = document.querySelector("#send-btn"); const stopping = b.classList.contains("stopping"); if (stopping) b.click(); return stopping; })()`).then(clicked => { evidence.stopClicked = clicked; });
    };
    const messages = () => rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""').then(String);
    const receipts = () => rp.evaluate(panel, '[...document.querySelectorAll(".memory-receipt")].map(e => e.innerText)') as Promise<string[]>;

    if (c.side) {
      await until(async () => (await messages()).includes(TASK_REPLY) || undefined, 60_000, "task answer visible");

      if (c.name === "side503") await until(async () => (await receipts()).find(r => /已记住.*北京/.test(r)), 30_000, "「已记住…北京」回执");
      else await new Promise(resolve => setTimeout(resolve, 8_000));
    } else if (c.stopAfterMs !== undefined) {
      await until(async () => stopAt !== undefined && await rp.evaluate(panel, '!document.querySelector("#send-btn").classList.contains("stopping")') || undefined, 30_000, "sidebar idle after stop");
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
      sideFailedAtMs: sideFailed.map(at => at - sentAt),
      backupSideRequestsAtMs: backupAsked.filter(r => !r.tools).map(r => r.at - sentAt),
      receipts: await receipts(),
      switchNotice: text.match(/[^。]*换成[^。]*接着做。/)?.[0] ?? null,
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
      const secondAt = await sendAgain(2);
      evidence.second = { primaryAsked: primaryAsked.filter(at => at >= secondAt).length, backupTask: backupAsked.filter(r => r.tools && r.at >= secondAt).length };
      assert.equal(primaryAsked.length, 1, "不满 5 分钟，下一条不问主模型");
      assert.ok(backupAsked.some(r => r.tools && r.at >= secondAt), "不满 5 分钟，下一条由备用回答");
      assert.ok(!(await messages()).includes("已换回"), "不满 5 分钟，没有「已换回」");
      await rp.evaluate(offscreenSession, "(() => { const real = Date.now.bind(Date); Date.now = () => real() + 5 * 60_000 + 1_000; return true; })()");
      const thirdAt = await sendAgain(3);
      const primaryThird = primaryAsked.filter(at => at >= thirdAt);
      const backupThird = backupAsked.filter(r => r.tools && r.at >= thirdAt);
      const text = await messages();
      evidence.third = { primaryAtMs: primaryThird.map(at => at - thirdAt), backupTaskAtMs: backupThird.map(r => r.at - thirdAt), returnNotice: text.match(/已换回[^。]*。/)?.[0] ?? null };
      assert.equal(primaryThird.length, 1, "满 5 分钟后的下一条先问主模型");
      assert.ok(backupThird.length >= 1 && backupThird.every(r => r.at >= primaryThird[0]!), "主模型又出错，之后才换回备用");
      assert.match(text, /已换回 .*primary-model/, "侧栏写明换回了主模型");
      assert.equal(text.match(/换成 阶跃星辰/g)?.length, 2, "主模型再出错时又换到备用");
      await rp.screenshot(panel, join(artifacts, "sidebar-after-return.png"));
    }

    if (c.side) {
      assert.ok(sideFailed.length >= 1, "主模型对短调用回了错误码");
      assert.equal(taskToBackup.length, 0, "任务请求没有换到备用模型");

      if (c.name === "side503") {
        assert.ok(backupAsked.some(r => !r.tools), "备用模型（阶跃星辰）收到了短调用");
        assert.ok((evidence.receipts as string[]).some(r => /已记住.*北京/.test(r)), "侧栏出现「已记住…北京」");
      } else {
        assert.equal(backupAsked.length, 0, "401 不换：备用模型一个请求都没收到");
        assert.ok(!(evidence.receipts as string[]).some(r => /已记住/.test(r)), "没有记住");
      }
    } else if (c.stopAfterMs !== undefined) {
      evidence.stopAtMs = stopAt! - sentAt;
      evidence.idle = await rp.evaluate(panel, '!document.querySelector("#send-btn").classList.contains("stopping")');
      const witness = await rp.evaluate(offscreenSession, "globalThis.__r2 ?? null") as { at: number; stopped: boolean } | null;
      evidence.switchWitness = witness && { atMs: witness.at - sentAt, stopped: witness.stopped };
      evidence.raceHit = witness?.stopped === true;
      assert.equal(evidence.idle, true, "侧栏停下了");
      assert.ok(!text.includes(ANSWER), "没有备用模型的回答");

      if (evidence.raceHit) assert.equal(taskToBackup.length, 0, "换模型途中点了「停」，备用模型没有收到任务请求");
    } else if (c.name === "hang" || c.name === "503") {
      if (c.name === "hang") {
        assert.ok(primaryAsked.length === 2 && primaryAsked[1]! - primaryAsked[0]! < 15_000, "主模型只有原请求和一份对冲，不在原模型上重试");
        assert.ok(taskToBackup.length >= 1 && taskToBackup[0]!.at - primaryAsked[0]! < 17_000, `彻底挂住时在 15 秒上限换到备用模型（${taskToBackup[0] ? taskToBackup[0].at - primaryAsked[0]! : null} ms）`);
      } else assert.equal(primaryAsked.length, 1, "主模型只被问一次，不在原模型上重试");
      assert.ok(taskToBackup.length >= 1, "备用模型（阶跃星辰）收到了任务请求");
      assert.ok(visibleMs <= (c.name === "503" ? 10_000 : BOUND_MS), `回答在时限内出现（${visibleMs} ms）`);
      assert.match(text, /主模型暂时不可用，换成 阶跃星辰 · step-3\.7-flash 接着做/, "侧栏写明换成了哪个模型");
    } else if (!c.switchBack) {
      assert.equal(taskToBackup.length, 0, "没有换到备用模型");
      assert.ok(!/换成 .* 接着做/.test(text), "侧栏没有切换提示");
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

    if (task !== backup) await task.close();
    main.closeAllConnections();
    main.close();
  }

  return { name: c.name, status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null, ...(c.stopAfterMs !== undefined ? { raceHit: evidence.raceHit ?? null, backupTaskRequests: evidence.backupTaskRequestsAtMs ?? null } : {}) };
}
