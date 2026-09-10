#!/usr/bin/env node
/**
 * 示范录制真机验收（隔离实例，合成输入）。
 *
 * 用单独 profile 启动 Chrome for Testing + 本仓库 extension/dist，
 * 在真实页面上用 CDP Input 域派发可信鼠标/键盘事件，模拟用户的点击、输入、回车、提交、填密码。
 *
 * 说明与边界：
 *   - 这是**合成输入**，不等于人手验收；用户真实手感仍由人评。
 *   - 面板按钮用脚本点击（面板不是被测对象）；页面动作全部走 CDP Input。
 *   - 不碰用户日常 Chrome，也不碰 local.yishu.chrome-main。
 *
 * 用法: node scripts/acceptance/demo-record-run.mjs [--keep]
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createCdp, connectBrowser, fetchJson, findServiceWorker, evaluateInWorker } from "./cdp.mjs";
import { extensionIdFromKey } from "./constants.mjs";
import { compileSkill } from "../../agent/src/skill-compile.js";
import { PROTOCOL_VERSION } from "../../shared/protocol.js";

/**
 * 协议桩：只提供 hello / skill_compile 两条。
 * 编译用的是真编译器（agent/src/skill-compile.ts），不是手写假数据；
 * 技能落盘那一段由 agent/test/skill-store.test.ts 覆盖。
 */
async function startStubAgent() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 7758 });
  const seen = [];
  const skills = [];
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      seen.push(msg);
      if (msg.type === "hello") socket.send(JSON.stringify({ type: "hello_ok", version: PROTOCOL_VERSION, model: "stub/demo" }));
      if (msg.type === "skill_compile") {
        const skill = compileSkill({
          id: "skill-acceptance0001",
          demoId: msg.demoId,
          intent: msg.intent,
          hostname: msg.hostname,
          steps: msg.steps,
        });
        skills.push(skill);
        socket.send(JSON.stringify({ type: "skill_result", requestId: msg.requestId, conversationId: msg.conversationId, action: "compile", ok: true, skill }));
      }
    });
  });
  return {
    seen,
    skills,
    close: async (timeoutMs = 2000) => {
      for (const socket of server.clients) socket.terminate();
      await Promise.race([
        new Promise((r) => server.close(() => r())),
        new Promise((r) => setTimeout(r, timeoutMs)),
      ]);
    },
  };
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(repoRoot, "extension", "dist");
const CHROME = "/Users/mahaoxuan/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const PORT = 9411;

const SECRET = "hunter2-not-in-steps";
const NOTE = "示范备注文本";

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>示范验收夹具</title></head>
<body style="font:16px -apple-system;margin:40px">
  <h1>客户列表</h1>
  <p id="phase">count-is-0</p>
  <input id="search" type="search" placeholder="客户名" aria-label="客户名" />
  <button id="run-btn" type="button">筛选</button>
  <ul><li><a id="first-row" href="#row1">第一条记录</a></li><li><a id="second-row" href="#row2">第二条记录</a></li></ul>
  <form id="note-form" onsubmit="event.preventDefault();document.getElementById('phase').textContent='submitted'">
    <input id="note" type="text" placeholder="备注" aria-label="备注" />
    <input id="secret" type="password" placeholder="密码" aria-label="密码" />
    <button id="save-btn" type="submit">保存</button>
  </form>
  <script>
    document.getElementById('run-btn').addEventListener('click', () => { document.getElementById('phase').textContent = 'filtered'; });
    document.getElementById('first-row').addEventListener('click', (e) => { e.preventDefault(); document.getElementById('phase').textContent = 'row-opened'; });
  </script>
</body></html>`;

const timeline = [];
function say(line) { timeline.push(line); console.log(line); }

async function startFixture() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

const launchArgs = [];
function launch(profile) {
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    `--load-extension=${DIST}`,
    `--disable-extensions-except=${DIST}`,
    "--disable-component-extensions-with-background-pages",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1100,760",
    // 无头运行：不创建任何窗口，绝不抢用户前台。
    // 扩展在 new headless 下可用；页面动作仍走 CDP Input 的真实事件。
    "--headless=new",
    "about:blank",
  ];
  launchArgs.splice(0, launchArgs.length, ...args);
  return spawn(CHROME, args, { stdio: "ignore", detached: false });
}

async function waitForPort() {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { await fetchJson(`http://127.0.0.1:${PORT}/json/version`, 1000); return; } catch { /* 还没起来 */ }
    if (Date.now() > deadline) throw new Error("Chrome 调试端口 20 秒内没起来");
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function waitFor(fn, label, timeoutMs = 15_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function pageSession(cdp, sessionId) {
  const evalIn = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };
  const centerOf = async (selector) => evalIn(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const click = async (selector) => {
    const at = await waitFor(() => centerOf(selector), `元素可点 ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 }, sessionId);
    }
    return at;
  };
  const type_ = async (text) => { await cdp.send("Input.insertText", { text }, sessionId); };
  const pressEnter = async () => {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" }, sessionId);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
  };
  return { evalIn, click, type: type_, pressEnter };
}

const LOCK = join(tmpdir(), "sideagent-demo-record.lock");

/** 同机只允许一个实例：内存本来就紧，叠着跑会把机器压死。 */
async function acquireLock() {
  try {
    const held = Number((await readFile(LOCK, "utf8")).trim());
    if (Number.isInteger(held) && held > 1 && processExists(held)) {
      throw new Error(`已有验收实例在跑（pid ${held}）。等它结束再跑，别叠着占内存。`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("已有验收实例")) throw error;
  }
  await writeFile(LOCK, String(process.pid), "utf8");
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function main() {
  const keep = process.argv.includes("--keep");
  const extId = extensionIdFromKey(JSON.parse(readFileSync(join(repoRoot, "extension", "manifest.json"), "utf8")).key);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await acquireLock();
  const evidenceDir = join(tmpdir(), `sideagent-demo-record-${stamp}`);
  await mkdir(evidenceDir, { recursive: true });
  const profile = await mkdtemp(join(tmpdir(), "sideagent-demo-profile-"));

  const fixture = await startFixture();
  const chrome = launch(profile);
  /**
   * 被信号打断时要自己收尸：否则会留下一个无头 Chrome 占着内存，
   * 而这台机器本来就常年在 23/24 GB 上跑。
   */
  const killChild = () => {
    try { chrome.kill("SIGKILL"); } catch { /* 已经退出 */ }
    void fixture.close();
  };
  process.once("SIGINT", () => { killChild(); process.exit(130); });
  process.once("SIGTERM", () => { killChild(); process.exit(143); });
  process.once("uncaughtException", (error) => { say(`未捕获异常：${error?.message ?? error}`); killChild(); process.exit(1); });
  let cdp;
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

  try {
    await waitForPort();
    const { cdp: browser } = await connectBrowser(PORT);
    cdp = browser;

    say(`扩展 ID ${extId}；夹具 ${fixture.origin}；证据 ${evidenceDir}`);
    const worker = await waitFor(async () => {
      const { targetInfos } = await cdp.send("Target.getTargets");
      return findServiceWorker(targetInfos, extId);
    }, "扩展 service worker 出现");
    const workerSession = await cdp.attachSession(worker.targetId);
    await evaluateInWorker(cdp, workerSession, "1+1");

    const pageTarget = await cdp.send("Target.createTarget", { url: `${fixture.origin}/index.html` });
    const pageTab = await fetchJson(`http://127.0.0.1:${PORT}/json/list`).then(list => list.find(t => t.id === pageTarget.targetId));
    const pageId = pageTab?.id;
    const pageSessionId = await cdp.attachSession(pageTarget.targetId);
    const page = pageSession(cdp, pageSessionId);
    await cdp.send("Page.enable", {}, pageSessionId);
    await waitFor(() => page.evalIn("document.readyState === 'complete' ? true : false"), "夹具页就绪");

    const panelTarget = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/sidepanel.html` });
    const panelSessionId = await cdp.attachSession(panelTarget.targetId);
    const panel = pageSession(cdp, panelSessionId);
    await waitFor(() => panel.evalIn("document.querySelector('#record-toggle') ? true : false"), "面板出现「看我做」按钮");

    // 用户此刻在看夹具页：只在这个测试窗口内把它设为活动标签页（不动用户当前前台应用）。
    await cdp.send("Target.activateTarget", { targetId: pageTarget.targetId });
    await new Promise((r) => setTimeout(r, 300));

    const isolated = (fnSource) => evaluateInWorker(cdp, workerSession,
      `chrome.tabs.query({url:${JSON.stringify(fixture.origin + "/*")}}).then(tabs=>{const t=tabs[0];if(!t)return null;return chrome.scripting.executeScript({target:{tabId:t.id},world:'ISOLATED',func:${fnSource}}).then(r=>r[0]?.result ?? null)})`);
    const pageRecording = () => isolated("() => window.__sideagent?.record?.recording?.() ?? null");

    // 1) 点「看我做」
    await panel.evalIn("document.querySelector('#record-toggle').click(), true");
    let recordingOnPage = false;
    try {
      recordingOnPage = await waitFor(async () => (await pageRecording()) === true, "页面进入示范模式", 8000) === true;
    } catch (error) {
      say(`诊断：页面未进入示范模式（${error.message}）`);
      const active = await evaluateInWorker(cdp, workerSession, "chrome.tabs.query({active:true}).then(t=>JSON.stringify(t.map(x=>({id:x.id,url:(x.url||'').slice(0,60),windowId:x.windowId}))))");
      say(`后台看到的活动标签页：${active}`);
      const lastFocused = await evaluateInWorker(cdp, workerSession, "chrome.tabs.query({active:true,lastFocusedWindow:true}).then(t=>JSON.stringify(t.map(x=>({id:x.id,url:(x.url||'').slice(0,60)}))))");
      say(`后台看到的 lastFocusedWindow 活动标签页：${lastFocused}`);
      const body = await panel.evalIn("document.body.innerText.slice(-600)");
      say(`面板文本尾部：\n${body}`);
    }
    check("点「看我做」后页面进入示范模式", recordingOnPage === true);
    const titleAfterStart = await waitFor(async () => {
      const t = await panel.evalIn("document.querySelector('#demo-title').textContent");
      return /已记下/.test(t || "") ? t : null;
    }, "面板出现录制提示", 6000).catch(() => null);
    check("面板显示录制提示", Boolean(titleAfterStart), titleAfterStart ?? "没等到标题");

    // 2) 用户动作：筛选 → 输入关键词 → 回车 → 点第一条记录
    await page.click("#run-btn");
    const inputReached = await waitFor(() => page.evalIn("document.querySelector('#phase').textContent === 'filtered'"), "点击命中页面", 5000).catch(() => false);
    check("CDP 输入确实打到了页面（夹具自身状态变化）", inputReached === true);
    await page.click("#search");
    await page.type("张三");
    await page.pressEnter();
    await page.click("#first-row");
    // 3) 敏感字段：备注（普通）与密码（必须不记内容）
    await page.click("#note");
    await page.type(NOTE);
    await page.click("#secret");
    await page.type(SECRET);
    await page.click("#save-btn");

    // 先结束示范（stop 会补发最后一批），再等列表稳定后逐条核对，避免抢时机拿到半截。
    await cdp.send("Target.activateTarget", { targetId: pageTarget.targetId });
    await panel.evalIn("document.querySelector('#record-toggle').click(), true");
    const stopped = await waitFor(async () => (await pageRecording()) === false, "页面停止录制", 8000);
    check("点「做完了」后页面停止录制", stopped === true);

    let steps = null;
    let last = null;
    const stableDeadline = Date.now() + 10_000;
    for (;;) {
      const text = await panel.evalIn("document.querySelector('#demo-steps').innerText");
      if (text && text === last && text.includes("保存")) { steps = text; break; }
      last = text;
      if (Date.now() > stableDeadline) { steps = text; break; }
      await new Promise((r) => setTimeout(r, 400));
    }

    await writeFile(join(evidenceDir, "panel-steps.txt"), steps ?? "(空)", "utf8");
    check("步骤列表出现在面板", Boolean(steps));
    say(`步骤原文：\n${steps}`);

    if (steps) {
      check("记下点击按钮「筛选」", steps.includes("点击按钮「筛选」"));
      check("记下在搜索框输入「张三」", steps.includes("在搜索框「客户名」里输入「张三」"));
      check("记下按回车", steps.includes("按 回车"));
      check("记下点击链接「第一条记录」", steps.includes("点击链接「第一条记录」"));
      check("记下普通输入内容", steps.includes(NOTE));
      check("密码只记「填了」不记内容", steps.includes("内容已隐藏") && !steps.includes(SECRET), steps.includes(SECRET) ? "明文泄漏" : "");
      check("步骤里没有坐标与 DOM 路径", !/nth-of-type|>\s*(div|span|button)\b|x:\s*\d+/.test(steps));
    }

    // 4) 背景缓冲里也不能有密码明文
    const pageSelfCheck = await isolated("() => JSON.stringify(window.__sideagent?.record?.selfCheck?.() ?? null)");
    say(`页面侧自检（停止后）：${pageSelfCheck}`);
    const buffered = await evaluateInWorker(cdp, workerSession, `(async () => {
      const store = await chrome.storage.local.get(null);
      return JSON.stringify(store).includes(${JSON.stringify(SECRET)}) ? "LEAK" : "clean";
    })()`);
    check("扩展存储里没有密码明文", buffered === "clean", String(buffered));

    // 5) 结束后步骤仍留在面板，且是看得见的（不能被收走）
    check("结束后步骤仍留在面板", (steps || "").includes("筛选"));
    const afterStop = await waitFor(async () => {
      const view = await panel.evalIn("JSON.stringify({hidden: document.querySelector('#demo-strip').hidden, title: document.querySelector('#demo-title').textContent, lines: document.querySelector('#demo-steps').children.length})");
      const parsed = JSON.parse(view);
      return parsed.hidden === false && parsed.lines >= 10 ? parsed : null;
    }, "收工后步骤条仍在", 5000).catch(() => null);
    check("收工后步骤条仍然可见、步骤没有消失", Boolean(afterStop), afterStop ? afterStop.title : "步骤条被收走了");

    // 6) 编译成脚本：面板 → 后台 → 协议桩（真编译器）→ 回到面板
    let stub = null;
    try {
      stub = await startStubAgent();
    } catch (error) {
      say(`协议桩没起来（7758 被占用？）：${error.message}`);
    }
    if (stub) {
      await panel.evalIn("(() => { document.querySelector('#token-input').value = 'demo-acceptance-token'; document.querySelector('#setup-save').click(); return true; })()");
      await waitFor(() => Promise.resolve(stub.seen.some(m => m.type === 'hello')), "协议桩收到 hello", 10_000).catch(() => null);

      await panel.evalIn("(() => { document.querySelector('#demo-intent').value = '把筛选后的第一条记录打开看一眼'; return true; })()");
      await panel.evalIn("document.querySelector('#demo-compile').click(), true");
      const sent = await waitFor(() => stub.seen.find(m => m.type === "skill_compile"), "收到 skill_compile", 10_000).catch(() => null);
      check("面板把示范与意图交给伴随进程", Boolean(sent) && sent.steps.length === 12 && sent.hostname === "127.0.0.1", sent ? `${sent.steps.length} 步 / ${sent.hostname}` : "没收到");
      check("交给编译的意图来自输入框", sent?.intent === "把筛选后的第一条记录打开看一眼", String(sent?.intent ?? ""));

      const cardText = await waitFor(async () => {
        const text = await panel.evalIn("document.querySelector('#demo-skill').innerText || ''");
        return text.includes("已编译") ? text : null;
      }, "面板出现编译结果卡", 10_000).catch(() => null);
      check("面板显示编译结果卡", Boolean(cardText), cardText?.split("\n")[0] ?? "没有结果卡");

      const card = JSON.parse(await panel.evalIn(`(() => {
        const box = document.querySelector('#demo-skill');
        const details = box.querySelector('details');
        return JSON.stringify({
          lines: Array.from(box.querySelectorAll('ol li')).map(li => li.textContent),
          check: box.querySelector('.demo-skill-check')?.textContent ?? "",
          folded: details ? !details.open : null,
          program: details?.querySelector('pre')?.textContent ?? "",
          inputs: ${JSON.stringify(JSON.stringify(Object.keys({})))},
        });
      })()`));
      check("卡片给的是人话步骤，且与示范列表同一套说法", card.lines.length === 11 && card.lines[0] === "点击按钮「筛选」" && card.lines.includes("在搜索框「客户名」里输入「张三」"), `${card.lines.length} 行`);
      check("卡片写明完成凭证", /完成凭证/.test(card.check) && /保存/.test(card.check), card.check.slice(0, 40));
      check("脚本默认折起来，不铺在脸上", card.folded === true, String(card.folded));
      check("折起来的脚本里没有坐标与 DOM 路径", !/nth-of-type|\d+\s*,\s*\d+/.test(card.program));
      check("脚本里没有示范时输入的明文密码", !card.program.includes(SECRET) && stub.skills[0]?.inputs?.["密码"] === "");

      // 扩展的 WS 客户端还连着；不先掐掉，server.close() 会一直等它断开。
      await stub.close(2000);
    }

    // 7) 收起（放在截图之后，好让证据图里能看到卡片本身）

    // 步骤条单独截一张：它是这次要给人看的东西
    try {
      const hasStrip = await panel.evalIn("(() => { const el = document.querySelector('#demo-strip'); if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; })()");
      if (hasStrip) {
        await new Promise((r) => setTimeout(r, 400));
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, panelSessionId);
        if (shot?.data) await writeFile(join(evidenceDir, "panel-steps.png"), Buffer.from(shot.data, "base64"));
      }
    } catch (error) { say(`步骤条截图失败：${error.message}`); }

    // 留一张看得见的证据：结束时的面板与页面
    for (const [name, sessionId] of [["panel", panelSessionId], ["page", pageSessionId]]) {
      try {
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
        if (shot?.data) await writeFile(join(evidenceDir, `${name}.png`), Buffer.from(shot.data, "base64"));
      } catch (error) { say(`截图失败（${name}）：${error.message}`); }
    }

    await panel.evalIn("document.querySelector('#demo-close').click(), true");
    const dismissed = await waitFor(async () => (await panel.evalIn("document.querySelector('#demo-strip').hidden")) === true, "收起后不再显示", 4000).catch(() => false);
    check("点收起后不再显示这份记录", dismissed === true);

    await writeFile(join(evidenceDir, "timeline.txt"), timeline.join("\n"), "utf8");
    await writeFile(join(evidenceDir, "result.json"), JSON.stringify({ extId, origin: fixture.origin, checks: results, steps }, null, 2), "utf8");
  } catch (error) {
    check("运行未抛出异常", false, error instanceof Error ? error.message : String(error));
    await writeFile(join(evidenceDir, "timeline.txt"), timeline.join("\n"), "utf8");
  } finally {
    try { await cdp?.close(); } catch { /* 已断开 */ }
    await rm(LOCK, { force: true }).catch(() => undefined);
    await fixture.close();
    if (!keep) {
      chrome.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1200));
      try { chrome.kill("SIGKILL"); } catch { /* 已经退出 */ }
      await rm(profile, { recursive: true, force: true });
    }
  }

  const failed = results.filter((r) => !r.ok);
  say(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  say(`证据目录：${evidenceDir}`);
  process.exit(failed.length ? 1 : 0);
}

await main();
