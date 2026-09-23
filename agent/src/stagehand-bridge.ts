/**
 * ego × Stagehand 官方 Playwright 兼容层的接入点。
 *
 * 事实边界（不要夸大）：
 * - 这里复用的是 Stagehand 官方 Playwright compatibility runtime（vendored 源码，ego 补丁见同目录 PATCH.md，来源见
 *   ./vendor/stagehand/runtime.ts 与同目录 LICENSE），不是完整 SDK，也没有浏览器内批处理迁移。
 * - 兼容层跑在 browser_run 的 QuickJS 沙箱里；它需要的 RawPage/RawContext 由本文件里的
 *   prelude 适配到现有 browser RPC（browser.<tool>），因此每个动作都经过 tools.ts 的 call：
 *   同一 scope epoch/signal、权限闸门、任务页闸门、控制轮次与执行账本。
 * - 页面 JS（page.evaluate / 定位查询 / 打标）统一走现有 `js` 工具闸门，不经 Node 执行。
 *
 * 未支持的 RawPage/RawContext 方法一律抛明确错误，不静默降级。
 */
import { createPlaywrightCompatRuntime } from "./vendor/stagehand/runtime.js";

/**
 * 官方 runtime 的自包含源码，序列化进 QuickJS。
 * 上游明确要求该函数自包含（原实现也是用 Function#toString 序列化到扩展 SW 的）。
 */
export function stagehandRuntimeSource(): string {
  if (cachedRuntimeSource === null) {
    const source = Function.prototype.toString.call(createPlaywrightCompatRuntime);
    if (!source.startsWith("async function createPlaywrightCompatRuntime")) {
      throw new Error(
        "Stagehand 兼容层源码序列化失败：Function#toString 没有返回自包含的 createPlaywrightCompatRuntime（构建过程可能改写了函数名）。",
      );
    }
    cachedRuntimeSource = source;
  }
  return cachedRuntimeSource;
}

let cachedRuntimeSource: string | null = null;

/**
 * QuickJS 侧 prelude：__name 兜底、crypto/timeout 补齐、RawPage/RawContext 适配、门面守卫。
 *
 * 这个字符串被拼进 QuickJS 程序执行，因此只用单引号/双引号与字符串拼接，
 * 不出现反引号或 `${}`（避免外层模板字符串再次求值）。
 */
const PRELUDE = String.raw`
// esbuild keepNames 会插入 __name(fn,'fn')；上游 facade 用同一手法给页面侧兜底。
{
  const identity = (target) => target;
  for (let index = 0; index <= 32; index += 1) {
    globalThis[index === 0 ? "__name" : "__name" + index] = identity;
  }
}
if (typeof globalThis.crypto === "undefined" || typeof globalThis.crypto.randomUUID !== "function") {
  let sequence = 0;
  const hex = (size) => {
    let out = "";
    for (let index = 0; index < size; index += 1) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  };
  globalThis.crypto = {
    randomUUID: () => {
      sequence += 1;
      return hex(8) + "-" + hex(4) + "-4" + hex(3) + "-a" + hex(3) + "-" + hex(12);
    },
  };
}
if (typeof globalThis.setTimeout !== "function") {
  let sequence = 0;
  const timers = new Map();
  globalThis.setTimeout = (fn, ms) => {
    sequence += 1;
    const id = sequence;
    const entry = { cancelled: false };
    timers.set(id, entry);
    const delay = Math.max(0, Math.min(10000, Number(ms) || 0));
    void (async () => {
      try { await globalThis.browser.sleep({ ms: delay }); } catch { return; }
      if (entry.cancelled) return;
      timers.delete(id);
      try { fn(); } catch { /* 定时回调异常不影响程序结果 */ }
    })();
    return id;
  };
  globalThis.clearTimeout = (id) => {
    const entry = timers.get(id);
    if (entry) { entry.cancelled = true; timers.delete(id); }
  };
}
/** 兼容层要的原页句柄：无论用户随后切到哪个标签页，后续动作都带着这里的 tabId。 */
function __egoBoundTabId(listing, hint) {
  const tabs = listing && Array.isArray(listing.tabs) ? listing.tabs : [];
  const working = tabs.find((tab) => tab && tab.working === true && typeof tab.id === "number");
  if (typeof hint === "number") return hint;
  if (working) return working.id;
  throw new Error("ego bridge: 这个程序没有绑定的任务页面（list_tabs 里没有 working 页，工具也没有缺省页）。请先用 switch_tab/snapshot 指定页面，再运行 playwright 程序。");
}
function __egoRawBridge(browser, tabId, platform) {
  const fail = (reason) => { throw new Error("ego bridge: " + reason); };
  const call = (name, params) => browser[name](Object.assign({ tabId: tabId }, params || {}));
  const evaluateInPage = async (code) => {
    const data = await call("js", { code: String(code) });
    return data && typeof data === "object" && "value" in data ? data.value : undefined;
  };
  /** 函数形式的 page.evaluate：源码在页面里 eval，仍然经过 js 工具闸门。 */
  const evaluateFunction = (fn, arg) => {
    const payload = JSON.stringify({
      source: Function.prototype.toString.call(fn),
      argument: arg === undefined ? null : arg,
    });
    const code = "(async () => {"
      + "const identity = (target) => target;"
      + "for (let index = 0; index <= 32; index += 1) { globalThis[index === 0 ? " + JSON.stringify("__name") + " : " + JSON.stringify("__name") + " + index] = identity; }"
      + "const payload = " + payload + ";"
      + "const candidate = (0, eval)(" + JSON.stringify("(") + " + payload.source + " + JSON.stringify(")") + ");"
      + "const produced = typeof candidate === " + JSON.stringify("function") + " ? await candidate(payload.argument) : candidate;"
      + "return produced === undefined ? null : JSON.parse(JSON.stringify(produced));"
      + "})()";
    return evaluateInPage(code);
  };
  const mapKey = (key) => {
    const raw = String(key);
    if (raw === "ControlOrMeta") return platform === "darwin" ? "Meta" : "Control";
    if (raw.indexOf("ControlOrMeta+") === 0) {
      return (platform === "darwin" ? "Meta" : "Control") + raw.slice("ControlOrMeta".length);
    }
    return raw;
  };
  const waitFor = async (ms) => {
    const total = Number(ms);
    if (!Number.isFinite(total) || total < 0) fail("waitForTimeout 需要 0 以上的毫秒数");
    let left = total;
    while (left > 0) {
      const chunk = Math.min(left, 5000);
      await browser.sleep({ ms: chunk });
      left -= chunk;
    }
  };
  const rawLocator = (selector) => {
    const target = String(selector);
    const click = async (options) => {
      const settings = options || {};
      if (settings.button !== undefined && settings.button !== "left") {
        fail("locator.click 只支持左键（ego click 不派发右键/中键）");
      }
      if (typeof settings.clickCount === "number" && settings.clickCount !== 1) {
        fail("locator.click 只支持单击；双击请用 locator.dblclick()（真实 CDP 双击）");
      }
      const result = await call("click", { target: target });
      if (result && result.newTab) {
        fail("这次点击打开了新标签页（tabId " + String(result.newTab.tabId) + "），playwright 模式保持原页句柄、不跟随新页；需要新页时请用 browser.tabs/browser.click。");
      }
      return undefined;
    };
    return {
      dblclick: async () => { await call("double_click", { target: target }); return undefined; },
      click: click,
      fill: async (value) => { await call("fill", { target: target, value: String(value) }); return undefined; },
      hover: async () => { await call("hover", { target: target }); return undefined; },
      type: () => fail("locator.type/pressSequentially 未接入；请用 fill 写入，或用 locator.press/keyboard.press 发按键"),
      selectOption: () => fail("locator.selectOption 未接入（ego 没有下拉选择 RPC）；请在页面上点击选项"),
      setInputFiles: (paths) => {
      // 合法上传入口之一：只走 upload_file RPC；宿主 call / browser-program 在派发前做同一授权。
      // 此处不另写一套路径规则，也不经 raw CDP。
      const list = Array.isArray(paths) ? paths.map(String) : [String(paths)];
      return call("upload_file", { target: target, paths: list }).then(() => undefined);
    },
    };
  };
  const rawPage = {
    pageId: tabId,
    url: () => evaluateInPage("location.href"),
    title: () => evaluateInPage("document.title"),
    evaluate: (expression, arg) =>
      typeof expression === "function" ? evaluateFunction(expression, arg) : evaluateInPage(String(expression)),
    waitForTimeout: waitFor,
    // 只按「存在」轮询会连 state:visible/hidden/attached 和 disabled 一起忽略，
    // 那种“等待”是假通过；本轮不实现真实状态语义，直接拒绝。
    waitForSelector: () =>
      fail("page.waitForSelector 未接入（本桥只支持真实条件等待，不做单纯的元素计数轮询）；请用 browser.waitFor({selector,timeoutMs})，它等的是唯一、可见、未禁用的原生 CSS 目标。"),
    locator: (selector) => rawLocator(selector),
    type: () => fail("page.type 未接入；请用 page.locator(sel).fill(value) 或 browser.type_text"),
    keyPress: (key, options) => {
      const settings = options || {};
      if (typeof settings.delay === "number" && settings.delay > 0) {
        fail("press 的 delay 未接入（ego press_key 一次派发按键）；请去掉 delay，或分两次 press");
      }
      return call("press_key", { key: mapKey(key) }).then(() => undefined);
    },
    click: (x, y, options) => {
      const settings = options || {};
      if (settings.button !== undefined && settings.button !== "left") {
        fail("page.mouse.click 只支持左键（ego click 不派发右键/中键）");
      }
      if (typeof settings.clickCount === "number" && settings.clickCount !== 1) {
        fail("page.mouse.click 只支持单击（ego click 不派发多次点击）");
      }
      return call("click", { point: [Number(x), Number(y)] }).then(() => undefined);
    },
    hover: (x, y) => call("hover", { point: [Number(x), Number(y)] }).then(() => undefined),
    scroll: (x, y, deltaX, deltaY) => {
      if (Number(deltaX) !== 0) fail("page.mouse.wheel 的水平滚动未接入（ego scroll 只有纵向）");
      return call("scroll", { dy: Number(deltaY) }).then(() => undefined);
    },
    // 不返回伪造的 Response（status/ok 会假装 HTTP 成功）；导航语义请用 browser.navigate。
    goto: () => fail("page.goto 未接入（本桥不伪造导航响应）；请用 browser.navigate({url})"),
    snapshot: () => fail("RawPage.snapshot 未接入；请用 browser.snapshot()"),
    screenshot: () => fail("RawPage.screenshot 未接入；请用 browser.screenshot()（图片随工具结果返回）"),
    reload: () => fail("page.reload 未接入；请用 browser.navigate 重新打开当前 URL"),
    goBack: () => fail("page.goBack 未接入；goBack 会改变任务页历史，属于未支持动作"),
    goForward: () => fail("page.goForward 未接入；goForward 会改变任务页历史，属于未支持动作"),
    setViewportSize: () => fail("page.setViewportSize 未接入；ego 不改用户浏览器视口"),
    waitForLoadState: () => fail("page.waitForLoadState 未接入；请用 browser.waitFor({selector,timeoutMs}) 等具体目标"),
    close: () => fail("page.close 未接入；关标签页请用 browser.close_tab"),
    addInitScript: () => fail("page.addInitScript 未接入"),
    setExtraHTTPHeaders: () => fail("page.setExtraHTTPHeaders 未接入"),
    on: () => fail("page.on 未接入：ego 没有把浏览器事件流交给程序"),
    onCDP: () => fail("page.onCDP 未接入：ego 没有把 CDP 事件流交给程序"),
    sendCDP: () => fail("page.sendCDP 未接入：程序不能直接发 CDP 命令"),
    bringToFront: () => fail("page.bringToFront 未接入：ego 在真实动作时自己保证目标页在前台"),
  };
  const rawContext = {
    pages: async () => [rawPage],
    newPage: () => fail("context.newPage 未接入：playwright 模式只有绑定的那个任务页面"),
    setActivePage: () => fail("context.setActivePage 未接入：程序不能切换用户的活动页"),
    cookies: () => fail("context.cookies 未接入：ego 不把 Cookie 交给程序"),
    addCookies: () => fail("context.addCookies 未接入"),
    clearCookies: () => fail("context.clearCookies 未接入"),
    addInitScript: () => fail("context.addInitScript 未接入"),
    setExtraHTTPHeaders: () => fail("context.setExtraHTTPHeaders 未接入"),
    // 没有 request：官方 facade 的 requestFetch 会回退到 page.evaluate(fetch)，
    // 那就变成“用页面身份悄悄发网”。这里逐个方法直接拒绝，堵掉回退路径。
    // （注意：这不是新的网络政策——页面 JS 本来就能 fetch，js 工具仍走原闸门；
    //   这里只要求 playwright 的 request API 不要表面一致地绕过去。）
    request: {
      fetch: () => fail("context.request.fetch 未接入：ego 不通过 playwright 的 request API 发网；请用 browser.fetch"),
      get: () => fail("context.request.get 未接入：ego 不通过 playwright 的 request API 发网；请用 browser.fetch"),
      post: () => fail("context.request.post 未接入：ego 不通过 playwright 的 request API 发网；请用 browser.fetch"),
    },
  };
  return { page: rawPage, context: rawContext };
}
/** 兼容层门面里少数会在 ego 里静默做错事（或长时间空转）的入口，改成明确拒绝。 */
function __egoGuardFacade(facade) {
  const unavailable = (reason) => () => { throw new Error("ego bridge: " + reason); };
  const unavailableValue = (reason) => new Proxy({}, {
    get: (target, property) => {
      if (typeof property === "symbol") return undefined;
      throw new Error("ego bridge: " + reason);
    },
  });
  const requestReason = "playwright 的 request API 未接入：ego 不通过它发网；请用 browser.fetch";
  const eventReason = "ego 不把浏览器事件流交给程序，请用 browser.network/snapshot 观察";
  const wrap = (target, table) =>
    new Proxy(target, {
      get: (current, property, receiver) =>
        Object.prototype.hasOwnProperty.call(table, property)
          ? table[property]
          : Reflect.get(current, property, receiver),
    });
  // 官方 facade 的 page.context()/context.pages()/browser.contexts() 会返回它自己的
  // 未守卫对象，绕过下面的拒绝；这里让所有别名回到同一批守卫对象上。
  let page;
  const context = wrap(facade.context, {
    request: unavailableValue(requestReason),
    waitForEvent: unavailable("context.waitForEvent 未接入：playwright 模式只有绑定的那个任务页面"),
    pages: () => [page],
  });
  page = wrap(facade.page, {
    request: unavailableValue(requestReason),
    waitForEvent: unavailable("page.waitForEvent 未接入：" + eventReason),
    context: () => context,
    frames: () => [page],
  });
  // 兼容层的 browser 对象不进程序（程序里的 browser 仍是 ego 工具集），所以没有别名要收；
  // 真要用到它的那天，contexts()/newContext() 必须和上面一样回到守卫过的 context。
  return { page: page, context: context, browser: facade.browser, telemetry: facade.telemetry, artifacts: facade.artifacts, closeRequested: facade.closeRequested };
}
`;

export interface PlaywrightProgramOptions {
  /** 用户程序体（browser_run 的 code）。 */
  code: string;
  /** 工具发起时的任务缺省页（没有则为 null；程序第一步还会用 list_tabs 读一次绑定页）。 */
  pageTabId: number | null;
  /** 宿主平台，只用于 Playwright 的 ControlOrMeta 键名映射。 */
  platform: string;
}

/**
 * 生成 QuickJS 程序：prelude → 官方兼容层 → 用户代码。
 * 第一个子调用是 list_tabs（读绑定任务页 ID），之后所有动作都带固定 tabId。
 */
export function buildPlaywrightProgram(options: PlaywrightProgramOptions): string {
  const runtimeSource = stagehandRuntimeSource();
  const hint = typeof options.pageTabId === "number" ? String(options.pageTabId) : "null";
  const platform = JSON.stringify(options.platform);
  return [
    PRELUDE,
    runtimeSource,
    "(async () => {",
    "  const listing = await browser.list_tabs({});",
    "  const boundTabId = __egoBoundTabId(listing, " + hint + ");",
    "  const facade = await createPlaywrightCompatRuntime(__egoRawBridge(browser, boundTabId, " + platform + "));",
    "  const api = __egoGuardFacade(facade);",
    "  const value = await (async (page, context, browser) => {",
    options.code,
    "  })(api.page, api.context, browser);",
    "  return JSON.stringify(value === undefined ? null : value);",
    "})()",
  ].join("\n");
}
