#!/usr/bin/env npx tsx
/**
 * U03 sizes + U01 input latency with 2000 history + keyboard send/escape.
 * Production sidepanel bundle. Isolated headless Chrome. No daily profile.
 */
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createCdp } from "../acceptance/cdp.mjs";
import { REPO_ROOT } from "./lib/verify.js";

if (!process.argv.includes("--headless=new") && !process.argv.includes("--headless")) {
  console.error("panel-layout 只允许无头：请加 --headless=new");
  process.exit(2);
}

const CHROME =
  "/Users/mahaoxuan/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const WIDTHS = [320, 400, 520] as const;
const HEIGHTS = [600, 900] as const;
const ZOOMS = [100, 200] as const;
const PRIMARY = ["#input", "#send-btn", "#takeover-btn", "#conversation-new"];

const mock = `globalThis.uiMessages=[];globalThis.uiListeners=[];
const storage={get:async()=>({}),set:async()=>{},remove:async()=>{}};
globalThis.chrome={runtime:{getURL:p=>new URL(p,location.href).href,connect:()=>({onMessage:{addListener:f=>uiListeners.push(f)},onDisconnect:{addListener:()=>{}},disconnect:()=>{},postMessage:m=>{uiMessages.push(m);}})},storage:{local:storage,session:storage},tabs:{query:async()=>[{id:1,title:'正在查看的页面',url:'https://example.test/'}],onActivated:{addListener:()=>{}},onUpdated:{addListener:()=>{}},create:async()=>({id:2})}};
navigator.permissions.query=async()=>({state:'granted'});
navigator.mediaDevices.getUserMedia=async()=>{const a=new AudioContext();return a.createMediaStreamDestination().stream;};
globalThis.uiEmit=e=>uiListeners.forEach(fn=>fn(e));`;

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/mock.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(mock);
      return;
    }
    if (path === "/" || path === "/sidepanel.html") {
      res.setHeader("Content-Type", "text/html");
      res.end((await readFile("extension/sidepanel.html", "utf8")).replace("<script type=\"module\"", "<script src=\"mock.js\"></script><script type=\"module\""));
      return;
    }
    const file = resolve("extension/dist", `.${path}`);
    if (!file.startsWith(`${resolve("extension/dist")}/`)) throw new Error("path");
    res.setHeader("Content-Type", ({ ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" } as Record<string, string>)[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});

const report: {
  ok: boolean;
  cases: Array<Record<string, unknown>>;
  keyboard: Array<{ name: string; ok: boolean; detail?: string }>;
  input_p95_ms?: number;
  input_samples?: number;
  error?: string;
  errors: string[];
} = { ok: false, cases: [], keyboard: [], errors: [] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error("timeout");
}

let child: ReturnType<typeof spawn> | undefined;
let cdp: ReturnType<typeof createCdp> | undefined;

try {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/sidepanel.html`;
  const profile = await mkdtemp(join(tmpdir(), "ego-panel-layout-"));
  child = spawn(CHROME, ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  const port = await until(async () => {
    try {
      return (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
    } catch {
      return undefined;
    }
  });
  const info = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()) as { webSocketDebuggerUrl: string };
  cdp = createCdp(info.webSocketDebuggerUrl);
  await cdp.ready();
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const sid = await cdp.attachSession(target.targetId);
  cdp.onEvent("Runtime.exceptionThrown", (event: { params?: { exceptionDetails?: { exception?: { description?: string }; text?: string } } }) => {
    report.errors.push(event.params?.exceptionDetails?.exception?.description ?? event.params?.exceptionDetails?.text ?? "error");
  });
  await cdp.send("Runtime.enable", {}, sid);
  await cdp.send("Page.enable", {}, sid);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, sid);
  const evaluate = async (expression: string): Promise<any> => {
    const r = await cdp!.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  await cdp.send("Page.navigate", { url }, sid);
  await until(async () => (await evaluate("!!document.querySelector('#composer-bar')&&uiListeners.length>0")) || undefined);
  await evaluate(`uiEmit({kind:'conversations',selectedConversationId:'default',conversations:[{id:'default',title:'浏览当前页面',createdAt:1,updatedAt:1,state:'idle',mode:'act'}]});uiEmit({kind:'conn',state:'connected'});uiEmit({kind:'server',msg:{type:'hello_ok',version:1,model:'minimax-cn/MiniMax-M3',models:[{id:'minimax-cn/MiniMax-M3',provider:'minimax-cn',modelId:'MiniMax-M3',name:'MiniMax-M3'}]}});uiEmit({kind:'server',msg:{type:'status',conversationId:'default',state:'running'}});`);

  const inspect = `(function(){
    const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    const items = ${JSON.stringify(PRIMARY)}.map((sel) => {
      const el = document.querySelector(sel);
      if (!el || el.hidden) return { sel, ok: false, reason: 'missing' };
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const visible = r.width >= 8 && r.height >= 8 && style.visibility !== 'hidden' && style.display !== 'none'
        && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      return { sel, ok: visible, x: r.x, y: r.y, w: r.width, h: r.height, left: r.left, right: r.right };
    });
    return { overflow, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, items, ok: !overflow && items.every((i) => i.ok) };
  })()`;

  for (const width of WIDTHS) {
    for (const height of HEIGHTS) {
      for (const zoom of ZOOMS) {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: zoom / 100, mobile: false }, sid);
        await sleep(80);
        const geometry = await evaluate(inspect);
        report.cases.push({ width, height, zoom, ...geometry });
      }
    }
  }

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  const inputTiming = await evaluate(`(async()=>{
    const box = document.getElementById('messages');
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 2000; i++) {
      const d = document.createElement('div');
      d.className = 'msg user';
      d.textContent = '历史条目 ' + i;
      frag.appendChild(d);
    }
    box.appendChild(frag);
    const input = document.querySelector('#input');
    input.focus();
    const samples = [];
    for (let i = 0; i < 100; i++) {
      const text = '输入' + i;
      const t0 = performance.now();
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const shown = input.value === text;
      samples.push({ ms: performance.now() - t0, shown });
    }
    const times = samples.map((s) => s.ms).sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1];
    return { samples: samples.length, p95, allShown: samples.every((s) => s.shown), max: times[times.length - 1] };
  })()`);
  report.input_p95_ms = inputTiming.p95;
  report.input_samples = inputTiming.samples;
  report.keyboard.push({
    name: "2000 history input visible p95<=100ms",
    ok: inputTiming.samples === 100 && inputTiming.allShown && inputTiming.p95 <= 100,
    detail: `p95=${inputTiming.p95} max=${inputTiming.max}`,
  });

  await evaluate(`uiMessages.length=0;const i=document.querySelector('#input');i.value='键盘发送';i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
  await sleep(50);
  report.keyboard.push({
    name: "Enter sends task_action",
    ok: await evaluate(`uiMessages.some(m=>m.kind==='client'&&m.msg.type==='task_action'&&m.msg.request.text==='键盘发送')`),
  });

  await evaluate(`document.querySelector('#conversation-switcher').click();`);
  await sleep(80);
  const menuOpen = await evaluate(`!document.querySelector('#conversation-menu').hidden`);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, sid);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, sid);
  await sleep(80);
  const menuClosed = await evaluate(`document.querySelector('#conversation-menu').hidden`);
  report.keyboard.push({ name: "Escape closes conversation menu", ok: menuOpen && menuClosed, detail: `open=${menuOpen} closed=${menuClosed}` });

  const modelVisible = await evaluate(`!document.querySelector('#model-btn').hidden`);
  if (modelVisible) {
    await evaluate(`document.querySelector('#model-btn').click();`);
    await sleep(80);
    const opened = await evaluate(`document.querySelector('#model-btn').getAttribute('aria-expanded')==='true'`);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, sid);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, sid);
    await sleep(80);
    const closed = await evaluate(`document.querySelector('#model-btn').getAttribute('aria-expanded')!=='true'`);
    report.keyboard.push({ name: "Escape closes model menu", ok: opened && closed, detail: `open=${opened} closed=${closed}` });
  }

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
  const outDir = join(REPO_ROOT, "eval", "runs");
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeFile(join(outDir, `panel-layout-${stamp}.png`), Buffer.from(shot.data, "base64"));
  report.ok = report.cases.every((c) => c.ok === true) && report.keyboard.every((k) => k.ok) && report.errors.length === 0;
  const path = join(outDir, `panel-layout-${stamp}.json`);
  await writeFile(path, JSON.stringify({ ...report, path }, null, 2));
  console.log(JSON.stringify({
    ok: report.ok,
    path,
    failed: report.cases.filter((c) => c.ok !== true).map((c) => ({ width: c.width, height: c.height, zoom: c.zoom, overflow: c.overflow, items: c.items })),
    keyboard: report.keyboard,
    input_p95_ms: report.input_p95_ms,
    errors: report.errors,
  }, null, 2));
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (cdp) await cdp.close();
  if (child) {
    const exited = new Promise<void>((r) => child!.once("exit", () => r()));
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(3000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}
