import { sendCommand } from "../debugger.js";
import { activateTab, resolveWorkingTab } from "../state.js";
import { resolveKey } from "../../shared/keymap.js";

interface DomRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function ensureDomOps(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-domops.js"],
    world: "ISOLATED",
  });
}

/** 在页面 ISOLATED world 里执行 func 并取回结果。 */
async function callDom<Args extends unknown[], Result>(
  tabId: number,
  func: (...args: Args) => Result,
  args: Args,
): Promise<Awaited<Result>> {
  const results = await chrome.scripting.executeScript<Args, Result>({
    target: { tabId },
    world: "ISOLATED",
    func,
    args,
  });
  const first = results[0];
  if (!first) throw new Error("页面脚本未返回结果");
  return first.result as Awaited<Result>;
}

export async function click(params: {
  target?: string;
  point?: [number, number];
  label?: string;
}): Promise<{ clicked: true }> {
  const tab = await resolveWorkingTab();
  if (tab.id == null) throw new Error("工作标签页无效");
  const tabId = tab.id;
  const target = params.target;
  let point = params.point;
  if (!point && !target) throw new Error("click 需要 target 或 point 参数");

  if (target) {
    // target → 元素中心视口坐标
    await ensureDomOps(tabId);
    const rect = await callDom(
      tabId,
      (t: string): DomRect => {
        const dom = window.__sideagent?.dom;
        if (!dom) throw new Error("domops 未注入");
        return dom.rectOf(t);
      },
      [target],
    );
    if (!point) point = [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)];
  }

  await activateTab(tab);

  try {
    const [x, y] = point!;
    await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  } catch (e) {
    // debugger 不可用（如被 DevTools 占用）时退到 domops 合成事件
    if (target) {
      await ensureDomOps(tabId);
      await callDom(
        tabId,
        (t: string) => {
          const dom = window.__sideagent?.dom;
          if (!dom) throw new Error("domops 未注入");
          return dom.click(t);
        },
        [target],
      );
      return { clicked: true };
    }
    throw e;
  }
  return { clicked: true };
}

export async function fill(params: { target: string; value: string }): Promise<{ filled: true }> {
  const tab = await resolveWorkingTab();
  if (tab.id == null) throw new Error("工作标签页无效");
  // fill 始终走 domops（原生 value setter + input/change 事件，兼容 React 受控组件）
  await ensureDomOps(tab.id);
  await callDom(
    tab.id,
    (t: string, v: string) => {
      const dom = window.__sideagent?.dom;
      if (!dom) throw new Error("domops 未注入");
      return dom.fill(t, v);
    },
    [params.target, params.value],
  );
  return { filled: true };
}

export async function typeText(params: { text: string }): Promise<{ typed: true }> {
  const tab = await resolveWorkingTab();
  if (tab.id == null) throw new Error("工作标签页无效");
  await activateTab(tab);
  await sendCommand(tab.id, "Input.insertText", { text: params.text });
  return { typed: true };
}

export async function pressKey(params: { key: string }): Promise<{ pressed: true }> {
  const info = resolveKey(params.key);
  if (!info) throw new Error(`不支持的按键: ${params.key}`);
  const tab = await resolveWorkingTab();
  if (tab.id == null) throw new Error("工作标签页无效");
  await activateTab(tab);

  const base = {
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode,
    modifiers: info.modifiers,
  };
  await sendCommand(tab.id, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    ...base,
    ...(info.text !== undefined ? { text: info.text } : {}),
  });
  await sendCommand(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  return { pressed: true };
}

export async function scroll(params: { dy?: number; toBottom?: boolean }): Promise<{ atBottom: boolean }> {
  const tab = await resolveWorkingTab();
  if (tab.id == null) throw new Error("工作标签页无效");
  await ensureDomOps(tab.id);

  if (params.toBottom) {
    const res = await callDom(
      tab.id,
      (maxSteps: number) => {
        const dom = window.__sideagent?.dom;
        if (!dom) throw new Error("domops 未注入");
        return dom.scrollToBottom(maxSteps);
      },
      [20],
    );
    return { atBottom: res.atBottom };
  }

  const res = await callDom(
    tab.id,
    (dy: number | null) => {
      const dom = window.__sideagent?.dom;
      if (!dom) throw new Error("domops 未注入");
      return dom.scrollBy(dy);
    },
    [params.dy ?? null],
  );
  return { atBottom: res.atBottom };
}
