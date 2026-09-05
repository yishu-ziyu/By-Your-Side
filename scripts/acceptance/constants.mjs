import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

export const WRAPPER_BUNDLE_ID = "local.yishu.chrome-main";
export const FORBIDDEN_BUNDLE_ID = "com.google.Chrome";
export const WRAPPER_APP = join(homedir(), "Applications/Chrome.app");
export const CHROME_MAIN_DIR = join(homedir(), "Library/Application Support/Google/ChromeMain");
export const DEFAULT_CHROME_DIR = join(homedir(), "Library/Application Support/Google/Chrome");
export const NATIVE_CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const UNIQUE_TEXT = "SIDEAGENT_ACCEPTANCE_UNIQUE_TEXT_20260904";
export const INC_BUTTON_ID = "inc-btn";
export const INC_BUTTON_LABEL = "Add one";
export const INPUT_ID = "note-input";
export const FILL_VALUE = "acceptance-fill-ok";
export const COUNTER_BEFORE = "count-is-0";
export const COUNTER_AFTER = "count-is-1";
export const FILL_BEFORE = "fill-is-empty";
export const FILL_AFTER = `fill-is-${FILL_VALUE}`;
export const PHASE_IDLE = "phase-idle";
export const PHASE_CLICKED = "phase-clicked";
export const PHASE_CHANGED = "phase-changed";

export const DEFAULT_RUNS = 3;
export const STEP_TIMEOUT_MS = 30_000;

export const FAILURE = {
  chrome_main_not_found: "chrome_main_not_found",
  cdp_connect_failed: "cdp_connect_failed",
  extension_not_found: "extension_not_found",
  snapshot_mismatch: "snapshot_mismatch",
  click_no_change: "click_no_change",
  fill_mismatch: "fill_mismatch",
  resnapshot_mismatch: "resnapshot_mismatch",
  evidence_write_failed: "evidence_write_failed",
  writes_not_blocked: "writes_not_blocked",
  handback_copied_snapshot: "handback_copied_snapshot",
  takeover_failed: "takeover_failed",
  original_task_unproven: "original_task_unproven",
  unexpected: "unexpected",
};

export const USER_BLOCKED_ERROR = "页面现在归你，操作未执行";
export const LEAD_MARK = "lead";
export const WORKER_MARK = "wiki";
export const USER_LEAD_MARK = "user-lead";
export const USER_WORKER_MARK = "user-wiki";
export const TEAM_LEAD_SESSION = "main";
export const TEAM_WORKER_SESSION = "wiki";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** manifest key（base64 SPKI DER）→ 扩展 ID（与 install-host.mjs 同算法）。 */
export function extensionIdFromKey(key) {
  const der = Buffer.from(key, "base64");
  const hash = createHash("sha256").update(der).digest();
  return [...hash.subarray(0, 16)]
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
    .join("");
}

export function sideagentExtensionId() {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "extension/manifest.json"), "utf8"));
  if (!manifest.key) throw new Error("extension/manifest.json 缺少 key 字段，无法确定扩展 ID");
  return extensionIdFromKey(manifest.key);
}

export function fixturePath() {
  return join(repoRoot, "extension/test/fixtures/acceptance/index.html");
}

export function loadFixtureHtml() {
  return readFileSync(fixturePath(), "utf8");
}

export function repoRootPath() {
  return repoRoot;
}

export function recoveryChromeMain() {
  return [
    "找不到 local.yishu.chrome-main 的 ChromeMain 实例，或它没有可用的远程调试端口。",
    "恢复：",
    `  1. 确认包装应用存在：${WRAPPER_APP}（CFBundleIdentifier=${WRAPPER_BUNDLE_ID}）`,
    "  2. 用该包装打开已在运行的 ChromeMain，不要用 Spotlight 打开 /Applications/Google Chrome.app",
    `  3. 进程命令行须含 --user-data-dir=${CHROME_MAIN_DIR} 和 --remote-debugging-port`,
    "  4. 本命令不会启动、重启、退出或聚焦 Chrome",
  ].join("\n");
}

export function recoveryExtension(extId) {
  return [
    `找不到已加载的 SideAgent service worker（chrome-extension://${extId}/background.js）。`,
    "恢复：",
    "  1. 在 chrome-main 打开 chrome://extensions，确认 SideAgent 已加载且未停用",
    `  2. 扩展 ID 应为 ${extId}（由 manifest key 推导）`,
    "  3. 打开 SideAgent 侧边栏以唤醒 MV3 service worker",
    "  4. 本命令不会重载扩展、不会重启 Chrome",
  ].join("\n");
}
