/**
 * 真实路径验收驱动。
 *
 * 一次运行 = 一个隔离的无窗口 Chrome for Testing：扩展从当前源码构建到临时目录，换一把随机 key
 * （扩展 ID 与日常不同），经 Native Messaging 拉起当前源码的伴随进程。伴随进程的数据目录指到临时目录
 * （SIDEAGENT_DATA_DIR）；模型、语音、TypeSafe 都走真服务，凭据由它从 ~/.sideagent 原位只读。
 * 侧栏用 chrome.sidePanel.open 打开，是真侧栏，不是标签页里的 sidepanel.html。
 *
 * 不碰日常 Chrome、extension/dist、正在运行的日常伴随进程，也不写 ~/.sideagent。
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createCdp, fetchJson, findServiceWorker } from "../cdp.mjs";

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

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

async function dailyDistStamp(): Promise<string> {
  const files = ["manifest.json", "background.js", "sidepanel.js"];
  const stamps = await Promise.all(files.map((file) => stat(join(REPO, "extension/dist", file)).then((s) => `${s.size}:${s.mtimeMs}`, () => "missing")));

  return stamps.join("|");
}

/**
 * microphoneWav：用这个 WAV 充当麦克风，只放一遍；不给就没有麦克风。
 * withoutNativeHost：不注册伴随进程，模拟只装了扩展的电脑（扩展内 agent 实验）。
 */
export async function launchRealPath({ microphoneWav, withoutNativeHost = false }: { microphoneWav?: string; withoutNativeHost?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "sideagent-real-path-"));
  const dirs = { profile: join(root, "profile"), extension: join(root, "extension"), data: join(root, "data"), host: join(root, "host") };

  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });

  // build.mjs 会先清空输出目录；不带 SIDEAGENT_BUILD_DIST 就会清掉日常 Chrome 正在加载的 extension/dist。
  const distBefore = await dailyDistStamp();
  execFileSync(process.execPath, [join(REPO, "extension/build.mjs")], {
    env: { ...process.env, SIDEAGENT_BUILD_DIST: dirs.extension },
    stdio: ["ignore", "ignore", "pipe"],
  });

  if ((await dailyDistStamp()) !== distBefore) throw new Error("隔离构建期间 extension/dist 变了，停止运行");

  const { key, id } = newExtensionKey();
  const manifestPath = join(dirs.extension, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.key = key;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  // 日常配置只决定模型、代理和开关，里面没有凭据；复制过去让测试伴随进程和日常用同一个模型。
  const dailyConfig = join(DAILY_DATA_DIR, "config.json");

  if (existsSync(dailyConfig)) await copyFile(dailyConfig, join(dirs.data, "config.json"));

  // --model=provider/id：只换测试伴随进程的模型，日常配置不动。
  const modelOverride = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length);

  if (modelOverride) {
    const testConfig = existsSync(join(dirs.data, "config.json")) ? JSON.parse(await readFile(join(dirs.data, "config.json"), "utf8")) : {};
    await writeFile(join(dirs.data, "config.json"), JSON.stringify({ ...testConfig, model: modelOverride }, null, 2));
  }

  const wrapper = join(dirs.host, "native-host.sh");
  await writeFile(wrapper, [
    "#!/bin/bash",
    `echo $$ >> ${shellQuote(join(dirs.host, "pids"))}`,
    `export SIDEAGENT_DATA_DIR=${shellQuote(dirs.data)}`,
    "unset SIDEAGENT_TRACE_DIR SIDEAGENT_DOWNLOADS_DIR SIDEAGENT_ROUTE_SHADOW_DIR",
    `exec ${shellQuote(process.execPath)} ${shellQuote(join(REPO, "node_modules/tsx/dist/cli.mjs"))} ${shellQuote(join(REPO, "agent/src/main.ts"))} 2>> ${shellQuote(join(dirs.host, "wrapper-err.log"))}`,
    "",
  ].join("\n"));
  await chmod(wrapper, 0o755);
  await mkdir(join(dirs.profile, "NativeMessagingHosts"), { recursive: true });

  if (!withoutNativeHost) await writeFile(join(dirs.profile, "NativeMessagingHosts", "com.sideagent.host.json"), JSON.stringify({
    name: "com.sideagent.host",
    description: "SideAgent real-path acceptance host",
    path: wrapper,
    type: "stdio",
    allowed_origins: [`chrome-extension://${id}/`],
  }, null, 2));

  // 日常 Chrome 从程序坞启动，环境里没有这些变量；伴随进程要和日常一样从文件读凭据。
  const env = { ...process.env };

  for (const name of ["STEPFUN_API_KEY", "SIDEAGENT_STEP_PLAN_KEY", "TYPESAFE_API_KEY", "SIDEAGENT_DATA_DIR"]) delete env[name];

  const chrome = spawn(resolveChrome(), [
    "--headless=new",
    "--mute-audio",
    "--enable-unsafe-extension-debugging",
    `--user-data-dir=${dirs.profile}`,
    "--remote-debugging-port=0",
    `--disable-extensions-except=${dirs.extension}`,
    `--load-extension=${dirs.extension}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,900",
    // macOS 上音频服务的沙箱不让它读任意路径，文件麦克风会变成一片静音。
    ...(microphoneWav ? ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${microphoneWav}%noloop`, "--disable-features=AudioServiceSandbox"] : []),
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], env });

  let chromeStderr = "";
  chrome.stderr.on("data", (chunk) => {
    chromeStderr = (chromeStderr + chunk).slice(-200_000);
  });

  const port = await until(async () => {
    if (chrome.exitCode !== null) throw new Error(`Chrome 提前退出（${chrome.exitCode}）`);
    const text = await readFile(join(dirs.profile, "DevToolsActivePort"), "utf8").catch(() => "");

    return text.split("\n")[0] || undefined;
  }, 20_000, "Chrome 调试端口");

  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  const cdp = createCdp(version.webSocketDebuggerUrl);
  await cdp.ready();

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
  const openSidePanel = async (): Promise<string> => {
    const helper = (await cdp.send("Target.createTarget", { url: `chrome-extension://${id}/voice-permission.html`, background: true })).targetId;

    try {
      const session = await attach(helper);
      await until(async () => (await evaluate(session, `document.readyState === "complete" && !!globalThis.chrome?.windows`)) || undefined, 10_000, "辅助页加载");
      const windowId = Number(await evaluate(session, "chrome.windows.getCurrent().then((w) => w.id)"));
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

  const screenshot = async (sessionId: string, file: string) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
    await writeFile(file, Buffer.from(data, "base64"));
  };

  const hostLog = () => readFile(join(dirs.data, "agent.log"), "utf8").catch(() => "");

  /** 包装脚本记下的是 tsx 启动器的 PID，真正的伴随进程是它的子进程；两者都要退出。 */
  const hostProcesses = async (): Promise<number[]> => {
    const launchers = (await readFile(join(dirs.host, "pids"), "utf8").catch(() => "")).split(/\s+/).filter(Boolean).map(Number);

    const children = launchers.flatMap((pid) => {
      try {
        return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number);
      } catch {
        return [];
      }
    });

    return [...new Set([...launchers, ...children])];
  };

  const close = async () => {
    const hostPids = await hostProcesses();
    await cdp.close().catch(() => {});

    if (chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill("SIGTERM");
      await Promise.race([new Promise((done) => chrome.once("close", done)), sleep(5000)]);

      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
    }

    const deadline = Date.now() + 10_000;

    while (hostPids.some(isAlive) && Date.now() < deadline) await sleep(250);
    const leftover = hostPids.filter(isAlive);

    for (const pid of leftover) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* 已退出 */
      }
    }

    return { hostPids, exitedWithChrome: leftover.length === 0, killed: leftover };
  };

  return {
    root,
    dirs,
    extensionId: id,
    browser: String(version.Browser),
    cdp,
    targets,
    attach,
    detach,
    evaluate,
    openSidePanel,
    click,
    typeText,
    pressEnter,
    screenshot,
    hostLog,
    serviceWorker: async (): Promise<TargetInfo | undefined> => findServiceWorker(await targets(), id),
    chromeStderr: () => chromeStderr,
    close,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
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
