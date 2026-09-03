import { sendCommand } from "../debugger.js";
import { activateTab, resolveWorkingTab } from "../state.js";
import { resolveKey } from "../../shared/keymap.js";
import { isAxRef } from "../axstate.js";
import { oneLine } from "../util.js";

interface DomRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** "@N" → ref 号；非 @N 形式返回 null。 */
function parseRef(target: string): number | null {
  if (!target.startsWith("@")) return null;
  const n = Number(target.slice(1));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 把 backendDOMNodeId 解析成页面内元素并执行函数（CDP Runtime.callFunctionOn）。 */
async function callOnBackendNode<T>(
  tabId: number,
  backendNodeId: number,
  functionDeclaration: string,
  args?: unknown[],
): Promise<T> {
  const resolved = await sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", {
    backendNodeId,
  });
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error("节点无法解析（页面可能已变化）");
  const result = await sendCommand<{
    result?: { value?: T };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  }>(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    ...(args ? { arguments: args.map((value) => ({ value })) } : {}),
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "页面内执行失败",
    );
  }
  return result.result?.value as T;
}

/** AX ref → 元素中心视口坐标（scrollIntoView + getBoundingClientRect，与 domops 同语义）。 */
async function centerOfBackendNode(tabId: number, backendNodeId: number): Promise<[number, number]> {
  const rect = await callOnBackendNode<DomRect | undefined>(
    tabId,
    backendNodeId,
    `function() {
      const el = this;
      if (typeof el.scrollIntoViewIfNeeded === "function") el.scrollIntoViewIfNeeded({ block: "center", inline: "center" });
      else el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) throw new Error("元素不可见（零尺寸）");
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }`,
  );
  if (!rect) throw new Error("无法获取元素位置");
  return [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)];
}

/** AX ref → 填充（原生 value setter + input/change 事件，与 domops fill 同逻辑）。 */
async function fillBackendNode(tabId: number, backendNodeId: number, value: string): Promise<void> {
  await callOnBackendNode<unknown>(
    tabId,
    backendNodeId,
    `function(v) {
      const el = this;
      el.focus();
      const tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea") {
        const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(el, v);
        else el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      if (el.isContentEditable) {
        el.textContent = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }
      throw new Error("元素不可填充（非 input/textarea/contenteditable）");
    }`,
    [value],
  );
}

async function ensureDomOps(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-domops.js"],
    world: "ISOLATED",
  });
}

async function ensureCursor(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-cursor.js"],
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
    // target → 元素中心视口坐标。@N 若来自 AX 快照（ref 即 backendDOMNodeId）走 CDP；
    // 否则（DOM 回退快照的 ref 或 CSS/loc 形式）或 debugger 被占用时走 domops 页面内解析。
    const ref = parseRef(target);
    const backendNodeId = ref !== null && isAxRef(tabId, ref) ? ref : undefined;
    let resolvedViaCdp = false;
    if (backendNodeId !== undefined) {
      try {
        if (!point) point = await centerOfBackendNode(tabId, backendNodeId);
        resolvedViaCdp = true;
      } catch (e) {
        if (!/占用|DevTools|debugger|detach/i.test(oneLine(e))) {
          throw new Error(`ref @${ref} 已失效，请重新 snapshot（${oneLine(e)}）`);
        }
        // debugger 不可用：落到 domops 路径（注意此时 @N 依赖 DOM 快照的 refs，
        // 若上次快照是 AX 版会解析不到——属边缘情况，让 domops 报「已失效」即可）
      }
    }
    if (!resolvedViaCdp && !point) {
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
      point = [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)];
    }
  }

  await activateTab(tab);

  // 虚拟鼠标可视化：先平滑移动到目标点、播点击波纹，再真实派发点击。
  // 坐标取 scrollIntoView 之后算出的视口 point；光标驱动失败静默，不影响主流程。
  {
    const [vx, vy] = point!;
    try {
      await ensureCursor(tabId);
      await callDom(
        tabId,
        (x: number, y: number) => window.__sideagent?.cursor?.move(x, y),
        [vx, vy],
      );
      await new Promise((r) => setTimeout(r, 300));
      await callDom(
        tabId,
        (x: number, y: number) => window.__sideagent?.cursor?.click(x, y),
        [vx, vy],
      );
      await new Promise((r) => setTimeout(r, 150));
    } catch {
      // 页面禁止注入（如 chrome:// 页面）等场景：跳过可视化
    }
  }

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
  // AX 快照的 @N（ref 即 backendDOMNodeId）走 CDP（同 domops fill 逻辑）；其余走 domops 页面内解析
  const ref = parseRef(params.target);
  const backendNodeId = ref !== null && isAxRef(tab.id, ref) ? ref : undefined;
  if (backendNodeId !== undefined) {
    try {
      await fillBackendNode(tab.id, backendNodeId, params.value);
      return { filled: true };
    } catch (e) {
      if (!/占用|DevTools|debugger|detach/i.test(oneLine(e))) {
        throw new Error(`ref @${ref} 填充失败（${oneLine(e)}）`);
      }
      // debugger 不可用时落到 domops（其 refs 若无此 ref 会报「已失效」）
    }
  }
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
