/**
 * 在 SideAgent SW 里跑验收步骤。只调用 globalThis.__saCall
 * （= uplink.handleRaw(tool_call) → executeToolCall → handlers）。
 * 禁止在这里重写 snapshot/click/fill。
 */
export async function swDriver(opts) {
  const started = Date.now();
  const durations = {};
  const out = {
    tabId: null,
    snapshots: { before: "", afterClick: "", afterFill: "" },
    screenshots: {},
    via: {
      path: "uplink.handleRaw → onServerMessage → executeToolCall → gate.run → handlers",
      snapshot: "handlers.snapshot",
      click: "handlers.click",
      fill: "handlers.fill",
      screenshot: "handlers.screenshot",
    },
    durationsMs: durations,
    startedAt: started,
    elapsedMs: 0,
    stage: "init",
    error: null,
  };

  const call = globalThis.__saCall;
  if (typeof call !== "function") {
    out.stage = "hook";
    out.error = "globalThis.__saCall 不存在：未进入 executeToolCall";
    out.elapsedMs = Date.now() - started;
    return out;
  }

  const sid = opts.sessionId || "acpt";
  let seq = 0;

  async function tool(step, name, params) {
    const id = "acpt-" + name + "-" + ++seq;
    const t0 = Date.now();
    const msg = await call(id, name, params, sid);
    durations[step] = (durations[step] || 0) + (Date.now() - t0);
    if (!msg || msg.type !== "tool_result") throw new Error(name + " 未回 tool_result");
    if (msg.ok === false) throw new Error(msg.error || name + " failed");
    return msg.data;
  }

  async function shot(key) {
    try {
      const data = await tool(key, "screenshot", {});
      if (data && data.imageBase64) out.screenshots[key] = data.imageBase64;
    } catch {
      /* 截图失败不挡四步断言 */
    }
  }

  try {
    out.stage = "open_tab";
    const opened = await tool("open_tab", "open_tab", { url: opts.url });
    if (!opened || opened.tabId == null) throw new Error("open_tab 未返回 tabId");
    out.tabId = opened.tabId;

    out.stage = "snapshot";
    const before = await tool("snapshot", "snapshot", {});
    out.snapshots.before = before && before.text ? before.text : "";
    await shot("before");

    out.stage = "click";
    const clicked = await tool("click", "click", { target: opts.incSelector });
    if (clicked && clicked.held) throw new Error("click 被危险确认拦住，未真正点击");
    const afterClick = await tool("click", "snapshot", {});
    out.snapshots.afterClick = afterClick && afterClick.text ? afterClick.text : "";
    await shot("afterClick");

    out.stage = "fill";
    await tool("fill", "fill", { target: opts.inputSelector, value: opts.fillValue });
    const afterFill = await tool("resnapshot", "snapshot", {});
    out.snapshots.afterFill = afterFill && afterFill.text ? afterFill.text : "";
    await shot("afterFill");

    out.stage = "done";
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  } finally {
    if (out.tabId != null) {
      try {
        await call("acpt-close-" + Date.now(), "close_tab", { tabId: out.tabId }, sid);
      } catch {
        /* 标签可能已关 */
      }
    }
    out.elapsedMs = Date.now() - started;
  }
  return out;
}

export function buildDriverExpression(opts) {
  return `(${swDriver.toString()})(${JSON.stringify(opts)})`;
}
