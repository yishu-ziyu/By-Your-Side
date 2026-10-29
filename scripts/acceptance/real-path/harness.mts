/**
 * 真实路径验收驱动。
 *
 * 一次运行 = 一个隔离的无窗口 Chrome（默认 Chrome for Testing，EGO_ACCEPTANCE_CHROME 可换正式版）：扩展从当前源码构建到临时目录，换一把随机 key
 * （扩展 ID 与日常不同），只装扩展：agent 跑在扩展的 offscreen 文档里，不注册本机伴随进程（本机模式已退役）。
 * 侧栏用 chrome.sidePanel.open 打开，是真侧栏，不是标签页里的 sidepanel.html。
 *
 * 不碰日常 Chrome、extension/dist，也不写 ~/.sideagent。
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createCdp, fetchJson, findServiceWorker } from "../cdp.mjs";
import { trackTempDir } from "../temp-profile.mjs";
import { recordingDir, render, startRecording } from "./recording.mts";
import "../runs-ledger.mjs";

export const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

export const DAILY_DATA_DIR = join(homedir(), ".sideagent");

export type TargetInfo = { targetId: string; type: string; url: string; title: string };

type FileStamp = { size: number; mtimeMs: number };

export type DirSnapshot = Map<string, FileStamp>;

/** 写进 result.json 的读数：只允许可序列化的值。 */
export type Json = string | number | boolean | null | undefined | readonly Json[] | { readonly [key: string]: Json };

/** 用例结果与证据记录：键随用例而定，值必须是可序列化读数。 */
export type JsonRecord = { [key: string]: Json };

/** 本地夹具服务器都监听 TCP 端口，address() 此时一定是 AddressInfo。 */
export function siteAddress(server: { address(): AddressInfo | string | null }): AddressInfo {
  const address = server.address();

  // 管道服务返回字符串、未监听返回 null；只有 TCP 监听才是对象。
  if (address instanceof Object) return address;

  throw new Error("夹具服务器还没有监听 TCP 端口");
}

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export async function until<T>(read: () => Promise<T | null | undefined | false>, ms: number, label: string, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    const value = await read();

    if (value) return value;
    await sleep(intervalMs);
  }

  throw new Error(`等待超时（${Math.round(ms / 1000)} 秒）：${label}`);
}

export function requireHeadless(): void {
  if (process.argv.includes("--headless")) return;
  console.error("真实路径验收只在无窗口模式下运行，请加 --headless。");
  process.exit(2);
}

function resolveChrome(): string {
  if (process.env.EGO_ACCEPTANCE_CHROME) return process.env.EGO_ACCEPTANCE_CHROME;
  const root = join(homedir(), "Library/Caches/ms-playwright");
  const suffix = "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

  const versions = existsSync(root)
    ? readdirSync(root).filter((name) => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
    : [];

  for (const version of versions) {
    const candidate = join(root, version, suffix);

    if (existsSync(candidate)) return candidate;
  }

  throw new Error("找不到 Chrome for Testing：先 npx playwright install chromium，或设 EGO_ACCEPTANCE_CHROME");
}

/** 扩展 ID 由 manifest.key 决定：sha256 前 16 字节，每 4 位映射到 a–p。 */
function newExtensionKey() {
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const id = [...createHash("sha256").update(publicKey).digest().subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15)))
    .join("");

  return { key: publicKey.toString("base64"), id };
}

async function dailyDistStamp(): Promise<string> {
  const files = ["manifest.json", "background.js", "sidepanel.js"];
  const stamps = await Promise.all(files.map((file) => stat(join(REPO, "extension/dist", file)).then((s) => `${s.size}:${s.mtimeMs}`, () => "missing")));

  return stamps.join("|");
}

/** 两种入口共用的 CDP 操作：列目标、附着、执行脚本、打开真侧栏、点击、输入、截图。 */
function browserControls(cdp: ReturnType<typeof createCdp>, id: string) {
  const targets = async (): Promise<TargetInfo[]> => (await cdp.send("Target.getTargets")).targetInfos;
  const attach = async (targetId: string): Promise<string> => (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  const detach = (sessionId: string) => cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});

  const evaluate = async (sessionId: string, expression: string, { userGesture = false, timeoutMs = 30_000 } = {}) => {
    const reply = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId, timeoutMs);

    if (reply.exceptionDetails) throw new Error(`页面脚本出错：${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);

    return reply.result?.value;
  };

  /**
   * sidePanel.open 要求用户手势，后台 service worker 里调用会被拒；扩展页面加 CDP userGesture 可以。
   * 辅助页只在点击时申请麦克风，打开不会触发任何动作。
   */
  const openSidePanel = async (inWindow?: number): Promise<string> => {
    const helper = (await cdp.send("Target.createTarget", { url: `chrome-extension://${id}/voice-permission.html`, background: true })).targetId;

    try {
      const session = await attach(helper);
      await until(async () => (await evaluate(session, `document.readyState === "complete" && !!globalThis.chrome?.windows`)) || undefined, 10_000, "辅助页加载");
      const windowId = inWindow ?? Number(await evaluate(session, "chrome.windows.getCurrent().then((w) => w.id)"));
      const opened = await evaluate(session, `chrome.sidePanel.open({ windowId: ${windowId} }).then(() => "opened", (e) => "error: " + e.message)`, { userGesture: true });

      if (opened !== "opened") throw new Error(`打开侧栏失败：${opened}`);
    } finally {
      await cdp.send("Target.closeTarget", { targetId: helper }).catch(() => {});
    }

    const panel = await until(
      async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith(`chrome-extension://${id}/sidepanel.html`)),
      15_000,
      "真侧栏出现",
    );

    return panel.targetId;
  };

  const click = async (sessionId: string, selector: string, button: "left" | "right" = "left") => {
    const point = await evaluate(sessionId, `(() => {
      const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    })()`);

    if (!point) throw new Error(`找不到 ${selector}`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, sessionId);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button, clickCount: 1 }, sessionId);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button, clickCount: 1 }, sessionId);
  };

  const typeText = (sessionId: string, text: string) => cdp.send("Input.insertText", { text }, sessionId);

  const pressEnter = async (sessionId: string) => {
    const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...key }, sessionId);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, sessionId);
  };

  const capture = async (sessionId: string, file: string) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
    await writeFile(file, Buffer.from(data, "base64"));
  };

  const screenshot = async (sessionId: string, file: string) => {
    await capture(sessionId, file);

    // 界面总览（npm run gallery）要同一屏的深色版；只给侧栏补拍，网页本身没有深色。
    if (process.env.SIDEAGENT_GALLERY !== "1" || !/sidepanel\.html$/.test(String(await evaluate(sessionId, "location.pathname")))) return;
    // 用例自己可能已经切了深色或减少动态效果：拍完按原样切回，后面的判定照旧。
    const was = await evaluate(sessionId, '({ dark: matchMedia("(prefers-color-scheme: dark)").matches, reduce: matchMedia("(prefers-reduced-motion: reduce)").matches })') as { dark: boolean; reduce: boolean };
    const media = (dark: boolean) => cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }, { name: "prefers-reduced-motion", value: was.reduce ? "reduce" : "no-preference" }] }, sessionId);

    try {
      await media(true);
      await new Promise(resolve => setTimeout(resolve, 250));
      await capture(sessionId, file.replace(/\.png$/, ".dark.png"));
    } finally {
      await media(was.dark);
    }
  };

  return {
    targets,
    attach,
    detach,
    evaluate,
    openSidePanel,
    click,
    typeText,
    pressEnter,
    screenshot,
    serviceWorker: async (): Promise<TargetInfo | undefined> => findServiceWorker(await targets(), id),
  };
}

/**
 * 连到用户已开着的日常 Chrome（--remote-debugging-port，默认 9222），驱动已加载的 extension/dist。
 * 不构建、不注册伴随进程、不改配置；close 只关本次新开的标签页，不关浏览器、不动用户原有标签页。
 * 用于「日常 Chrome 里验收」：会在用户窗口里开新标签页和侧栏，必须先取得用户同意。
 */
export async function attachDailyChrome({ port = Number(process.env.CDP_PORT ?? 9222) } = {}) {
  const manifest = JSON.parse(await readFile(join(REPO, "extension/manifest.json"), "utf8"));
  const der = Buffer.from(String(manifest.key), "base64");

  const id = [...createHash("sha256").update(der).digest().subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15)))
    .join("");

  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  const cdp = createCdp(version.webSocketDebuggerUrl);
  await cdp.ready();
  const rp = browserControls(cdp, id);
  // 日常数据目录不复制进产物：给一个空目录，调用方的 traces 拷贝自然落空。
  const dirs = { data: await mkdtemp(join(tmpdir(), "sideagent-daily-")) };
  const tempDir = trackTempDir(dirs.data);
  const before = new Set((await rp.targets()).map((t) => t.targetId));

  // 在日常 Chrome 里另开一个不抢焦点的窗口放工作页和侧栏：用户正在用的窗口和前台应用都不动。
  // CDP 的 createTarget 开窗会激活 Chrome，所以经扩展页用 chrome.windows.create({focused:false})。
  const helper = (await cdp.send("Target.createTarget", { url: `chrome-extension://${id}/voice-permission.html`, background: true })).targetId;
  let windowId: number;
  try {
    const session = await rp.attach(helper);
    await until(async () => (await rp.evaluate(session, `document.readyState === "complete" && !!globalThis.chrome?.windows`)) || undefined, 10_000, "辅助页加载");
    windowId = Number(await rp.evaluate(session, `chrome.windows.create({ url: "about:blank", focused: false }).then((w) => w.id)`));
  } finally {
    await cdp.send("Target.closeTarget", { targetId: helper }).catch(() => {});
  }
  const { targetId: workTargetId } = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank" && !before.has(t.targetId)), 10_000, "后台工作窗口");

  const close = async () => {
    for (const t of await rp.targets()) {
      if (t.type === "page" && !before.has(t.targetId) && !t.url.startsWith(`chrome-extension://${id}/sidepanel.html`)) await cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    }

    await cdp.close().catch(() => {});

    const none: number[] = [];

    return { hostPids: none, exitedWithChrome: true, killed: none };
  };

  return {
    ...rp,
    extensionId: id,
    browser: String(version.Browser),
    cdp,
    dirs,
    /** 本次新开的工作标签页；用户可能另有 about:blank 标签页，不能按网址找。 */
    workTargetId: String(workTargetId),
    /**
     * 发任务前必须调用。侧栏和后台都按「最近获得焦点的窗口」找当前页（真人用时就是他在看的窗口），
     * 不抢前台的后台窗口永远不是它：任务会落到用户正开着的页面上，曾因此在用户的 flomo 里搜索、读到私人笔记。这时拒绝发送。
     */
    assertTasksStayInWorkWindow: async () => {
      const panel = (await rp.targets()).find((t) => t.type === "page" && t.url.startsWith(`chrome-extension://${id}/sidepanel.html`));
      const focused = panel ? await rp.evaluate(await rp.attach(panel.targetId), "chrome.windows.getLastFocused({ windowTypes: ['normal'] }).then((w) => w.id)").catch(() => null) : null;

      if (focused !== windowId) throw new Error("日常 Chrome 的测试窗口不是最近获得焦点的窗口，任务会作用到用户正在看的页面：不发送。要发任务的测试请用隔离浏览器。");
    },
    /** 侧栏开在后台工作窗口里，不开在用户正在用的窗口。 */
    openSidePanel: async () => {
      await rp.openSidePanel(windowId);
      // 用户自己的窗口里通常已开着侧栏：按窗口找这次后台窗口里的那个。
      return until(async () => {
        for (const t of await rp.targets()) {
          if (t.type !== "page" || !t.url.startsWith(`chrome-extension://${id}/sidepanel.html`)) continue;
          const own = await rp.evaluate(await rp.attach(t.targetId), "chrome.windows.getCurrent().then((w) => w.id)").catch(() => null);
          if (own === windowId) return t.targetId;
        }
        return undefined;
      }, 15_000, "后台窗口里的侧栏");
    },
    hostLog: async () => "",
    close,
    remove: async () => tempDir.release(),
  };
}

/** 扩展内 agent 发出的一次 HTTP 请求：相对观察开始的毫秒数。 */
export type InprocRequest = { url: string; method: string; startMs: number; firstByteMs: number | null; endMs: number | null; status: number | null; failed: string | null };

/**
 * 从外部观察 offscreen 里的扩展内 agent：扩展内没有 RunTrace，诊断只能靠这里。
 * 记录 console 输出与全部网络请求（模型服务、语音 WebSocket 握手），不改产品行为。
 */
export async function watchInproc(rp: { cdp: ReturnType<typeof createCdp>; targets: () => Promise<TargetInfo[]>; attach: (targetId: string) => Promise<string> }, extensionId: string) {
  const target = await until(async () => (await rp.targets()).find((t) => t.url === `chrome-extension://${extensionId}/inproc.html`), 30_000, "扩展内 agent 的 offscreen 文档");
  const session = await rp.attach(target.targetId);
  const origin = Date.now();
  const logs: string[] = [];
  const requests = new Map<string, InprocRequest>();
  const now = () => Date.now() - origin;

  /** 只收本 offscreen 会话的事件；参数形状由调用处按 CDP 规范声明。 */
  const on = <P,>(method: string, fn: (params: P) => void) => rp.cdp.onEvent(method, (message: { sessionId?: string; params: P }) => {
    if (message.sessionId === session) fn(message.params);
  });

  on<{ type: string; args?: Array<{ value?: Json; description?: string }> }>("Runtime.consoleAPICalled", (p) => {
    logs.push(`${now()}\t${p.type}\t${(p.args ?? []).map((a) => (a.value !== undefined ? String(a.value) : a.description ?? "")).join(" ")}`);
  });

  on<{ requestId: string; request: { url: string; method: string } }>("Network.requestWillBeSent", (p) => {
    requests.set(p.requestId, { url: p.request.url, method: p.request.method, startMs: now(), firstByteMs: null, endMs: null, status: null, failed: null });
  });

  on<{ requestId: string; response: { status: number } }>("Network.responseReceived", (p) => {
    const entry = requests.get(p.requestId);

    if (!entry) return;
    entry.firstByteMs = now();
    entry.status = p.response.status;
  });

  on<{ requestId: string }>("Network.loadingFinished", (p) => {
    const entry = requests.get(p.requestId);

    if (entry) entry.endMs = now();
  });

  on<{ requestId: string; errorText: string }>("Network.loadingFailed", (p) => {
    const entry = requests.get(p.requestId);

    if (!entry) return;
    entry.endMs = now();
    entry.failed = p.errorText;
  });

  // service worker 重启会清掉它内存里的状态（如 AX ref 登记表）：记下扩展后台的起停。
  const workerUrl = `chrome-extension://${extensionId}/background.js`;
  const workers = new Set<string>();

  rp.cdp.onEvent("Target.targetCreated", (message: { params: { targetInfo: TargetInfo } }) => {
    if (message.params.targetInfo.url !== workerUrl) return;
    workers.add(message.params.targetInfo.targetId);
    logs.push(`${now()}\tworker\tcreated ${message.params.targetInfo.targetId}`);
  });

  // targetDestroyed 只带 targetId：只记之前见过的后台 worker。
  rp.cdp.onEvent("Target.targetDestroyed", (message: { params: { targetId: string } }) => {
    if (workers.delete(message.params.targetId)) logs.push(`${now()}\tworker\tdestroyed ${message.params.targetId}`);
  });
  await rp.cdp.send("Target.setDiscoverTargets", { discover: true });
  await rp.cdp.send("Runtime.enable", {}, session);
  await rp.cdp.send("Network.enable", {}, session);

  return {
    now,
    logs: () => logs.join("\n"),
    /** 某个时间窗内开始的请求，按开始时间排序。 */
    requestsBetween: (fromMs: number, toMs = Number.POSITIVE_INFINITY) => [...requests.values()].filter((r) => r.startMs >= fromMs && r.startMs <= toMs).sort((a, b) => a.startMs - b.startMs),
  };
}

/**
 * 像用户一样在设置页「诊断记录」点导出（可选再点清空），返回页面上的状态文字和下载下来的文件内容。
 * 判据由调用方对文件本身做，不读产品内部存储。
 */
export async function exportDiagnosticsViaSettings(
  rp: { cdp: ReturnType<typeof createCdp>; attach: (targetId: string) => Promise<string>; evaluate: (sessionId: string, expression: string) => Promise<Json>; click: (sessionId: string, selector: string) => Promise<void> },
  extensionId: string,
  downloads: string,
  { clearAfter = false } = {},
) {
  await mkdir(downloads, { recursive: true });
  await rp.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  // 先开空白页挂上监听再进设置页：设置页启动时抛的错也要收得到，导出没反应时才看得出卡在哪。
  const { targetId } = await rp.cdp.send("Target.createTarget", { url: "about:blank" });
  const settings = await rp.attach(targetId);
  const pageErrors: string[] = [];
  type PageEvent = { sessionId?: string; params?: { type?: string; args?: Array<{ value?: unknown; description?: string }>; exceptionDetails?: { text?: string; exception?: { description?: string } } } };
  const offEvents = [
    rp.cdp.onEvent("Runtime.exceptionThrown", (message: PageEvent) => {
      if (message.sessionId === settings) pageErrors.push(String(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text).slice(0, 400));
    }),
    rp.cdp.onEvent("Runtime.consoleAPICalled", (message: PageEvent) => {
      if (message.sessionId === settings && message.params?.type === "error") pageErrors.push((message.params.args ?? []).map((arg) => String(arg.value ?? arg.description)).join(" ").slice(0, 400));
    }),
  ];
  await rp.cdp.send("Runtime.enable", {}, settings);
  await rp.cdp.send("Page.navigate", { url: `chrome-extension://${extensionId}/settings.html` }, settings);
  const status = async () => String(await rp.evaluate(settings, `document.querySelector("#trace-status")?.textContent ?? ""`));

  const exportOnce = async () => {
    await rp.evaluate(settings, `document.querySelector("#trace-status").textContent = ""; document.querySelector("#trace-export").scrollIntoView({ block: "center" }); true`);
    await rp.click(settings, "#trace-export");

    try {
      return await until(async () => {
        const text = await status();

        return text.startsWith("已导出") || text.includes("失败") || text.startsWith("还没有") ? text : undefined;
      }, 15_000, "导出结果");
    } catch (error) {
      const page = await rp.evaluate(settings, `JSON.stringify({ status: document.querySelector("#trace-status")?.textContent ?? null, buttonVisible: !!document.querySelector("#trace-export")?.getClientRects().length })`).catch((e) => `读不出页面：${e}`);
      throw new Error(`${error instanceof Error ? error.message : String(error)}；设置页 ${page}；页面报错 ${JSON.stringify(pageErrors)}`);
    }
  };

  try {
    // 诊断记录在「数据与诊断」分页里，没切过去时按钮是隐藏的、点不到。
    await until(async () => (await rp.evaluate(settings, `!!document.querySelector('[data-settings-page="data"]')`)) || undefined, 15_000, "设置页导航");
    await rp.click(settings, '[data-settings-page="data"]');
    await until(async () => (await rp.evaluate(settings, `!!document.querySelector("#trace-export")?.getClientRects().length`)) || undefined, 15_000, "设置页诊断记录区");
    const exportStatus = await exportOnce();
    const expectFiles = (exportStatus.match(/(\d+) 条任务记录/)?.[1] !== "0" ? 1 : 0) + (exportStatus.match(/(\d+) 条语音记录/)?.[1] !== "0" ? 1 : 0);

    const names = exportStatus.startsWith("已导出")
      ? await until(async () => { const found = (await readdir(downloads)).filter((name) => name.endsWith(".jsonl"));

        return found.length >= expectFiles ? found : undefined; }, 15_000, "导出文件落地")
      : [];

    const read = async (prefix: string) => {
      const name = names.find((file) => file.startsWith(prefix));

      return name ? readFile(join(downloads, name), "utf8") : "";
    };

    const traces = await read("by-your-side-traces-");
    const voice = await read("by-your-side-voice-");
    let clearedStatus: string | null = null;

    if (clearAfter) {
      await rp.click(settings, "#trace-clear");
      await until(async () => (await status()) === "已清空。" || undefined, 10_000, "清空");
      clearedStatus = await exportOnce();
    }

    return { exportStatus, traces, voice, clearedStatus };
  } finally {
    for (const off of offEvents) off();
    await rp.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

/**
 * microphoneWav：用这个 WAV 充当麦克风，只放一遍；不给就没有麦克风。
 * chromeArgs：额外的 Chrome 启动参数（如把语音服务地址映射到本机，模拟连不上）。
 * dist / SIDEAGENT_ACCEPTANCE_DIST：明确指定已准备的扩展包；复制到隔离目录，不重建或修改原包。同一进程里交错跑两版代码时用 dist。
 */
export async function launchRealPath({ microphoneWav, chromeArgs = [], headed = false, dist, recordFps, unpackedViaCdp = false }: { microphoneWav?: string; chromeArgs?: string[]; headed?: boolean; dist?: string; recordFps?: number; unpackedViaCdp?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "sideagent-real-path-"));
  // Removed by remove(), or at process end if the case fails or is interrupted before that.
  const tempDir = trackTempDir(root);
  const dirs = { profile: join(root, "profile"), extension: join(root, "extension"), data: join(root, "data"), downloads: join(root, "downloads") };

  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });

  // 这个配置目录的「下载」文件夹指到临时目录：页面下载不进用户真实的下载文件夹，也不弹保存对话框。
  await mkdir(join(dirs.profile, "Default"), { recursive: true });
  await writeFile(join(dirs.profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: dirs.downloads, prompt_for_download: false, directory_upgrade: true } }));

  // build.mjs 会先清空输出目录；不带 SIDEAGENT_BUILD_DIST 就会清掉日常 Chrome 正在加载的 extension/dist。
  const distBefore = await dailyDistStamp();
  const preparedDist = dist ?? process.env.SIDEAGENT_ACCEPTANCE_DIST;
  if (preparedDist) {
    const source = resolve(preparedDist);
    await readFile(join(source, "manifest.json"), "utf8");
    await cp(source, dirs.extension, { recursive: true });
  } else {
    execFileSync(process.execPath, [join(REPO, "extension/build.mjs")], {
      env: { ...process.env, SIDEAGENT_BUILD_DIST: dirs.extension },
      stdio: ["ignore", "ignore", "pipe"],
    });
  }

  if ((await dailyDistStamp()) !== distBefore) throw new Error("隔离构建期间 extension/dist 变了，停止运行");

  const { key, id } = newExtensionKey();
  const manifestPath = join(dirs.extension, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.key = key;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  // 日常 Chrome 从程序坞启动，环境里没有这些变量；隔离 Chrome 也不带。
  const env = { ...process.env };

  for (const name of ["STEPFUN_API_KEY", "SIDEAGENT_STEP_PLAN_KEY", "TYPESAFE_API_KEY", "SIDEAGENT_DATA_DIR"]) delete env[name];

  const chromeArgsFor = () => [
    // headed：只给无头 Chrome 复现不了的情况用（例如从没显示过的后台标签页不渲染，输入会丢）。
    ...(headed ? [] : ["--headless=new"]),
    // macOS：不读钥匙串里的「Chrome Safe Storage」，否则每启动一次就弹一次钥匙串授权框。
    "--use-mock-keychain",
    // Ubuntu runners deny Chrome's unprivileged namespace sandbox (same as isolated-extension).
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    "--mute-audio",
    "--enable-unsafe-extension-debugging",
    `--user-data-dir=${dirs.profile}`,
    "--remote-debugging-port=0",
    ...(unpackedViaCdp ? [] : [`--load-extension=${dirs.extension}`]),
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,900",
    // macOS 上音频服务的沙箱不让它读任意路径，文件麦克风会变成一片静音。
    ...(microphoneWav ? ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${microphoneWav}%noloop`, "--disable-features=AudioServiceSandbox"] : []),
    ...chromeArgs,
    // 有窗口时不带启动窗口，连上后用 background 开窗口：Chrome 开第一个窗口时会把自己推到最前，抢走用户的前台（10-19 用户反馈）。
    ...(headed && process.platform === "darwin" ? ["--no-startup-window"] : ["about:blank"]),
  ];
  // 有窗口时在 macOS 上用 open -g 在后台启动：直接启动的 GUI 应用会被推到最前面，抢走用户正在打字的焦点（10-13 用户反馈）。
  // open -W 一直等到 Chrome 退出，所以这个进程的退出就是 Chrome 的退出；kill 要按配置目录找到真正的 Chrome 进程。
  const openBackgroundWindow = async (cdp: ReturnType<typeof createCdp>) => {
    if (headed && process.platform === "darwin") await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true, background: true });
  };
  // 正式版 Chrome 忽略 --load-extension，只能经调试协议装入（需要 --enable-unsafe-extension-debugging）；
  // 旧版 Chrome for Testing 没有这个命令，靠 --load-extension 已经装好。
  // --disable-extensions-except 会把经调试协议装入的扩展也禁掉，所以不带。重启后再装一次，同一路径同一 id。
  const loadExtension = async (cdp: ReturnType<typeof createCdp>) => {
    const alreadyLoaded = await until(
      async () => ((await cdp.send("Target.getTargets")) as { targetInfos: TargetInfo[] }).targetInfos.some(t => t.url.startsWith(`chrome-extension://${id}/`)),
      1_500,
      "extension target",
      100,
    ).catch(() => false);
    if (alreadyLoaded) return;
    const loaded = await cdp.send("Extensions.loadUnpacked", { path: dirs.extension }).catch((error: Error) => {
      if (/Method not available|wasn't found/.test(error.message)) return undefined;
      throw error;
    });
    if (loaded && loaded.id !== id) throw new Error(`扩展装入后 id 不符：${loaded.id} ≠ ${id}`);
  };
  const spawnChrome = () => {
    if (!headed || process.platform !== "darwin") return spawn(resolveChrome(), chromeArgsFor(), { stdio: ["ignore", "ignore", "pipe"], env });
    const app = resolveChrome().replace(/(\.app)\/Contents\/MacOS\/.*$/, "$1");
    // BYS_TEST_BROWSER_FRONT=1：用户要盯着看时，启动那一下放到最前面（只这一下，之后不再抢）。
    const child = spawn("open", [...(process.env.BYS_TEST_BROWSER_FRONT === "1" ? [] : ["-g"]), "-n", "-W", "--stderr", join(root, "chrome-stderr.log"), "-a", app, "--args", ...chromeArgsFor()], { stdio: ["ignore", "ignore", "pipe"], env });
    const endOpen = child.kill.bind(child);
    child.kill = (signal?: NodeJS.Signals | number) => {
      const pids = spawnSync("pgrep", ["-f", "--", `--user-data-dir=${dirs.profile}`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);
      for (const pid of pids) { try { process.kill(pid, signal ?? "SIGTERM"); } catch { /* 已退出 */ } }
      return pids.length ? true : endOpen(signal);
    };
    return child;
  };

  let chrome = spawnChrome();
  tempDir.setChild(chrome);

  let chromeStderr = "";
  let chromeSpawnError: Error | undefined;
  chrome.on("error", error => { chromeSpawnError = error; });
  chrome.stderr.on("data", (chunk) => {
    chromeStderr = (chromeStderr + chunk).slice(-200_000);
  });

  const port = await until(async () => {
    if (chromeSpawnError) throw chromeSpawnError;

    if (chrome.exitCode !== null || chrome.signalCode !== null) throw new Error(`Chrome 提前退出（${chrome.exitCode ?? chrome.signalCode}）`);
    const text = await readFile(join(dirs.profile, "DevToolsActivePort"), "utf8").catch(() => "");

    return text.split("\n")[0] || undefined;
  }, 60_000, "Chrome 调试端口").catch((error: Error) => {
    const detail = `${error.message}\nChrome stderr (tail):\n${chromeStderr.slice(-8000)}`;
    chrome.kill("SIGKILL");
    tempDir.release();
    throw new Error(detail);
  });

  // Chrome is up but close() does not exist yet: a failure here (e.g. the version fetch timing out under load) must kill it,
  // or the orphaned Chrome keeps the caller's process alive (10-14: one eval round hung 18 minutes after "done").
  let version: { Browser: unknown; webSocketDebuggerUrl: string };
  let cdp: ReturnType<typeof createCdp>;
  try {
    version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    cdp = createCdp(version.webSocketDebuggerUrl);
    await cdp.ready();
    await loadExtension(cdp);
    await openBackgroundWindow(cdp);
    const setup = browserControls(cdp, id);
    const target = (await cdp.send("Target.createTarget", { url: "chrome://extensions/", background: true })).targetId;
    try {
      const page = await setup.attach(target);
      await until(async () => await setup.evaluate(page, "!!globalThis.chrome?.developerPrivate") || undefined, 10_000, "隔离浏览器的扩展管理页");
      await setup.evaluate(page, "chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})");
    } finally {
      await cdp.send("Target.closeTarget", { targetId: target }).catch(() => {});
    }
  } catch (error) {
    chrome.kill("SIGKILL");
    tempDir.release();
    throw error;
  }

  const controls = browserControls(cdp, id);

  const recordTo = recordingDir();
  const recording = recordTo ? await startRecording(recordTo, id, { fps: recordFps }) : null;
  recording?.follow(cdp);

  if (recording) console.log(`录屏：${relative(process.cwd(), recording.dir)}`);

  const hostLog = () => readFile(join(dirs.data, "agent.log"), "utf8").catch(() => "");

  const shutdown = async () => {
    await cdp.close().catch(() => {});

    if (chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill("SIGTERM");
      await Promise.race([new Promise((done) => chrome.once("close", done)), sleep(5000)]);

      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
    }

    // 不注册本机伴随进程，所以没有可能残留的本机进程；字段保留给沿用它的检查。
    const none: number[] = [];

    return { hostPids: none, exitedWithChrome: true, killed: none };
  };

  let rendered: Promise<void> | null = null;

  // 先停录屏再关 Chrome；合成放在 Chrome 退出之后，不和用例抢 CPU。
  const close = async () => {
    await recording?.stop();
    const closed = await shutdown();

    if (recording) await (rendered ??= render(recording.dir).then(
      (made) => console.log(
        made === "no-frames" ? "录屏：没录到画面，跳过合成"
        : made === "no-ffmpeg" ? `录屏：找不到 ffmpeg 和 ffprobe（PATH=${process.env.PATH ?? ""}），跳过合成；帧留在 ${relative(process.cwd(), recording.dir)}，装好后 npm run frames -- 这个目录`
        : `慢放录屏：${relative(process.cwd(), made.slow)}　总览：${relative(process.cwd(), made.overview)}　逐帧看：npm run frames -- ${relative(process.cwd(), recording.dir)} <起秒> <止秒>`,
      ),
      (error: Error) => console.log(`录屏合成失败：${error.message.split("\n")[0]}`),
    ));

    return closed;
  };

  const result = {
    root,
    dirs,
    extensionId: id,
    browser: String(version.Browser),
    cdp,
    ...controls,
    hostLog,
    chromeStderr: () => chromeStderr,
    close,
    remove: async () => tempDir.release(),
    async restart({ abrupt = false } = {}) {
      if(abrupt) {
        await cdp.close().catch(() => {});
        chrome.kill("SIGKILL");
        await Promise.race([new Promise(done => chrome.once("close",done)),sleep(5000)]);
      } else await shutdown();
      await unlink(join(dirs.profile, "DevToolsActivePort")).catch(() => {});
      chrome = spawnChrome();
      tempDir.setChild(chrome);
      chrome.stderr.on("data", chunk => { chromeStderr = (chromeStderr + chunk).slice(-200_000); });

      const nextPort = await until(async () => {
        if (chrome.exitCode !== null) throw new Error(`Chrome重启退出: ${chrome.exitCode}`);

        return (await readFile(join(dirs.profile, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n")[0] || undefined;
      }, 60_000, "同配置Chrome重启");

      const next = await fetchJson(`http://127.0.0.1:${nextPort}/json/version`);
      cdp = createCdp(next.webSocketDebuggerUrl);
      await cdp.ready();
      await loadExtension(cdp);
      await openBackgroundWindow(cdp);
      recording?.follow(cdp);
      Object.assign(result, { cdp, ...browserControls(cdp, id) });
    },
  };

  return result;
}

// ── 日常数据隔离的证据 ──────────────────────────────────────────

/** 凭据按文件名跳过：快照和扫描都不打开它们。 */
const isCredentialFile = (name: string) => /\.(key|env)$/.test(name);

export async function snapshotDir(root: string): Promise<DirSnapshot> {
  const snapshot: DirSnapshot = new Map();

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && !isCredentialFile(entry.name)) {
        const s = await stat(full).catch(() => null);

        if (s) snapshot.set(relative(root, full), { size: s.size, mtimeMs: s.mtimeMs });
      }
    }
  };

  await walk(root);

  return snapshot;
}

export function changedFiles(before: DirSnapshot, after: DirSnapshot): string[] {
  return [...after].flatMap(([path, now]) => {
    const was = before.get(path);

    return !was || was.size !== now.size || was.mtimeMs !== now.mtimeMs ? [path] : [];
  });
}

/** 只在内存里比对字节，不输出文件内容。大文件分块读，块之间重叠 needle 长度，跨块的标记也能找到。 */
export async function filesContaining(root: string, paths: Iterable<string>, needle: string) {
  const token = Buffer.from(needle, "utf8");
  const hits: string[] = [];
  const unreadable: string[] = [];

  for (const path of paths) {
    const full = join(root, path);

    if (!existsSync(full)) continue;
    const found = await streamIncludes(full, token).catch(() => null);

    if (found === null) unreadable.push(path);
    else if (found) hits.push(path);
  }

  return { hits, unreadable };
}

async function streamIncludes(file: string, token: Buffer): Promise<boolean> {
  let carry = Buffer.alloc(0);

  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    // SAFETY: createReadStream 没有设 encoding，读出的每块都是 Buffer。
    const window = Buffer.concat([carry, chunk as Buffer]);

    if (window.includes(token)) return true;
    carry = window.subarray(Math.max(0, window.length - token.length + 1));
  }

  return false;
}

/** 会话记录（Pi session JSONL）里每条模型回复都带 provider、model 和 stopReason；报错的回复也会留一条。 */
export async function modelReplies(dataDir: string): Promise<Array<{ provider: string; model: string; stopReason: string }>> {
  const files = [...(await snapshotDir(dataDir)).keys()].filter((file) => file.startsWith("conversations/") && file.endsWith(".jsonl"));
  const replies: Array<{ provider: string; model: string; stopReason: string }> = [];

  for (const file of files) {
    for (const line of (await readFile(join(dataDir, file), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      const message = JSON.parse(line).message;

      if (message?.role === "assistant") replies.push({ provider: String(message.provider), model: String(message.model), stopReason: String(message.stopReason) });
    }
  }

  return replies;
}

export async function sha256File(path: string): Promise<string | null> {
  const content = await readFile(path).catch(() => null);

  return content ? createHash("sha256").update(content).digest("hex") : null;
}

export function listenerPids(port: number): number[] {
  try {
    return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** esbuild 遇到 `./x.js` 时优先用磁盘上真有的 x.js：未跟踪的旧 .js 会顶替同名 .ts 进入扩展构建。 */
export function shadowedSources(): Array<{ file: string; sourceNewer: boolean }> {
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "shared", "extension/src"], { cwd: REPO, encoding: "utf8" });

  return untracked.split("\n")
    .filter((file) => file.endsWith(".js") && existsSync(join(REPO, file.replace(/\.js$/, ".ts"))))
    .map((file) => ({ file, sourceNewer: statSync(join(REPO, file.replace(/\.js$/, ".ts"))).mtimeMs > statSync(join(REPO, file)).mtimeMs }));
}

type ScreencastFrame = { sessionId?: string; params: { data: string; sessionId: number; metadata: { timestamp?: number } } };

/**
 * 录下一个页面（如侧栏）的画面，停下时按真实节奏合成 mp4（要本机 ffmpeg）。给用户直接看真实运行的样子（10-07 用户要求）。
 * 画面只在变化时出帧；每帧显示到下一帧为止。没录到画面或没有 ffmpeg 时返回 null，不影响验收。
 */
export async function recordScreen(cdp: ReturnType<typeof createCdp>, sessionId: string, file: string): Promise<() => Promise<string | null>> {
  const frames: Array<{ at: number; data: string }> = [];

  const off = cdp.onEvent("Page.screencastFrame", (message: ScreencastFrame) => {
    if (message.sessionId !== sessionId) return;
    frames.push({ at: message.params.metadata.timestamp ?? Date.now() / 1000, data: message.params.data });
    void cdp.send("Page.screencastFrameAck", { sessionId: message.params.sessionId }, sessionId).catch(() => {});
  });

  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 75, everyNthFrame: 1 }, sessionId);

  return async () => {
    off();
    await cdp.send("Page.stopScreencast", {}, sessionId).catch(() => {});

    if (frames.length < 2) return null;
    const dir = await mkdtemp(join(tmpdir(), "sideagent-video-"));
    const list: string[] = [];

    for (const [i, frame] of frames.entries()) {
      const name = join(dir, `${String(i).padStart(5, "0")}.jpg`);
      await writeFile(name, Buffer.from(frame.data, "base64"));
      // 按真实间隔显示，不设下限：动画时一秒几十帧，每帧补到 0.04 秒会把视频拉长好几倍（10-07 实测 3 分钟录成 10 分钟）。
      list.push(`file '${name}'`, `duration ${Math.max(0.001, (frames[i + 1]?.at ?? frame.at + 1) - frame.at).toFixed(3)}`);
    }

    // concat 的最后一帧要再写一次文件名，时长才生效。
    list.push(`file '${join(dir, `${String(frames.length - 1).padStart(5, "0")}.jpg`)}'`);
    await writeFile(join(dir, "list.txt"), list.join("\n"));

    try {
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"), "-fps_mode", "cfr", "-r", "25", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", file]);

      return file;
    } catch {
      return null;
    } finally {
      execFileSync("rm", ["-rf", dir]);
    }
  };
}
