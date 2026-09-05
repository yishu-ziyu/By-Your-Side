import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHROME_MAIN_DIR,
  DEFAULT_CHROME_DIR,
  FORBIDDEN_BUNDLE_ID,
  NATIVE_CHROME_BIN,
  WRAPPER_APP,
  WRAPPER_BUNDLE_ID,
  recoveryChromeMain,
} from "./constants.mjs";

function defaultExec(file, args, encoding = "utf8") {
  return execFileSync(file, args, { encoding, stdio: ["ignore", "pipe", "pipe"] });
}

function readPlistBundleId(appPath, readFile, exists) {
  const plist = join(appPath, "Contents/Info.plist");
  if (!exists(plist)) return null;
  const text = readFile(plist, "utf8");
  const m = text.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
  return m ? m[1].trim() : null;
}

export function parsePsLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  const pid = Number(parts[0]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const command = trimmed.slice(trimmed.indexOf(parts[0]) + parts[0].length).trim();
  return { pid, command };
}

export function isBrowserMainProcess(command) {
  if (!command.includes(NATIVE_CHROME_BIN) && !command.includes("Google Chrome.app/Contents/MacOS/Google Chrome")) {
    return false;
  }
  if (command.includes("Helper")) return false;
  if (command.includes("Google Chrome for Testing")) return false;
  if (command.includes("chrome-headless") || command.includes("scoped_dir")) return false;
  if (command.includes("ms-playwright")) return false;
  return true;
}

export function classifyBrowserCommand(command, dirs) {
  const chromeMainDir = dirs.chromeMainDir ?? CHROME_MAIN_DIR;
  const defaultDir = dirs.defaultChromeDir ?? DEFAULT_CHROME_DIR;
  if (!isBrowserMainProcess(command)) return "other";
  if (command.includes(chromeMainDir) || /--user-data-dir=\S*ChromeMain/.test(command)) {
    return "chrome-main";
  }
  if (command.includes("Chrome-headless") || command.includes("for Testing")) return "foreign";
  if (command.includes(defaultDir) && !command.includes("ChromeMain")) return "default-chrome";
  if (!command.includes("--user-data-dir=")) return "default-chrome";
  return "foreign";
}

export function parseRemoteDebuggingPort(command) {
  const m = command.match(/--remote-debugging-port=(\d+)/);
  if (!m) return null;
  const port = Number(m[1]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

export function parseLsofListenPids(lsofText) {
  const pids = new Set();
  for (const line of lsofText.split("\n")) {
    if (!line || line.startsWith("COMMAND")) continue;
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

export function parseDevToolsActivePort(text) {
  const first = String(text ?? "").split(/\r?\n/)[0]?.trim();
  const port = Number(first);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/**
 * 只认包装 bundle local.yishu.chrome-main 对应的 ChromeMain 实例。
 * 拒绝默认 profile / Playwright / Testing。不启动、不退出 Chrome。
 */
export function discoverChromeMain(io = {}) {
  const exec = io.exec ?? defaultExec;
  const readFile = io.readFile ?? readFileSync;
  const exists = io.exists ?? existsSync;
  const chromeMainDir = io.chromeMainDir ?? CHROME_MAIN_DIR;
  const defaultChromeDir = io.defaultChromeDir ?? DEFAULT_CHROME_DIR;
  const wrapperApp = io.wrapperApp ?? WRAPPER_APP;

  if (!exists(wrapperApp)) {
    const err = new Error(recoveryChromeMain());
    err.failureCategory = "chrome_main_not_found";
    throw err;
  }
  const bundle = readPlistBundleId(wrapperApp, readFile, exists);
  if (bundle !== WRAPPER_BUNDLE_ID) {
    const err = new Error(
      `包装应用 bundle 不是 ${WRAPPER_BUNDLE_ID}，实际 ${bundle ?? "(missing)"}。\n${recoveryChromeMain()}`,
    );
    err.failureCategory = "chrome_main_not_found";
    throw err;
  }

  let psText = "";
  try {
    psText = exec("ps", ["-ax", "-o", "pid=,command="]);
  } catch (e) {
    const err = new Error(`无法列出进程：${e instanceof Error ? e.message : e}\n${recoveryChromeMain()}`);
    err.failureCategory = "chrome_main_not_found";
    throw err;
  }

  const chromeMain = [];
  const defaultChrome = [];
  for (const line of psText.split("\n")) {
    const row = parsePsLine(line);
    if (!row) continue;
    const kind = classifyBrowserCommand(row.command, { chromeMainDir, defaultChromeDir });
    if (kind === "chrome-main") chromeMain.push(row);
    if (kind === "default-chrome") defaultChrome.push(row);
  }

  if (chromeMain.length === 0) {
    const extra = defaultChrome.length
      ? `\n检测到 ${FORBIDDEN_BUNDLE_ID} 默认实例 pid=${defaultChrome.map((p) => p.pid).join(",")}，本命令不会连接或控制它。`
      : "";
    const err = new Error(`${recoveryChromeMain()}${extra}`);
    err.failureCategory = "chrome_main_not_found";
    throw err;
  }

  const browser = chromeMain[0];
  const cmdlinePort = parseRemoteDebuggingPort(browser.command);
  const portFile = join(chromeMainDir, "DevToolsActivePort");
  let filePort = null;
  if (exists(portFile)) {
    try {
      filePort = parseDevToolsActivePort(readFile(portFile, "utf8"));
    } catch {
      filePort = null;
    }
  }
  const port = cmdlinePort ?? filePort;
  if (!port) {
    const err = new Error(
      `ChromeMain pid ${browser.pid} 没有 --remote-debugging-port / DevToolsActivePort。\n${recoveryChromeMain()}`,
    );
    err.failureCategory = "cdp_connect_failed";
    throw err;
  }

  let lsofText = "";
  try {
    lsofText = exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  } catch {
    const err = new Error(`127.0.0.1:${port} 没有监听进程。\n${recoveryChromeMain()}`);
    err.failureCategory = "cdp_connect_failed";
    throw err;
  }
  const listenPids = parseLsofListenPids(lsofText);
  if (!listenPids.includes(browser.pid)) {
    const err = new Error(
      `端口 ${port} 的监听进程是 pid=${listenPids.join(",") || "?"}，不是 ChromeMain pid=${browser.pid}。拒绝连接。\n${recoveryChromeMain()}`,
    );
    err.failureCategory = "cdp_connect_failed";
    throw err;
  }

  return {
    wrapperBundleId: WRAPPER_BUNDLE_ID,
    wrapperApp,
    pid: browser.pid,
    port,
    userDataDir: chromeMainDir,
    command: browser.command,
    refusedDefaultChromePids: defaultChrome.map((p) => p.pid),
  };
}
