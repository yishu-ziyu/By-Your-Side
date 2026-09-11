/**
 * 浏览器工具的 defineTool 封装。
 * 每个 execute 只做一件事：rpc.call 转发给扩展，再把结果转成模型友好的 content。
 * 工具名严格对齐 shared/protocol.ts 的 TOOL_NAMES / ToolContract。
 * 教学模式不裁剪工具能力（教学倾向由 prompt 层表达），全部工具始终可用。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ELEMENT_PROPERTIES } from "../../shared/element-state.js";
import { formatEffectReport } from "../../shared/effect.js";
import { formatFetchReply, type FetchReply } from "./fetch-result.js";
import { fetchPages } from "./fetch-batch.js";
import { redactCredentialText, wrapPageContent } from "../../shared/untrusted.js";
import { isLeadSession, type TabInfo, type ToolContract, type ToolName } from "../../shared/protocol.js";
import { WRITE_TOOLS, isWriteTool } from "../../shared/control.js";
import type { ToolRpc } from "./rpc.js";
import { runBrowserProgram, type ProgramStep } from "./browser-program.js";

const MAX_JS_RESULT_CHARS = 20_000;

function textResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

function formatTabs(tabs: TabInfo[]): string {
  if (tabs.length === 0) return "No open tabs.";
  return tabs
    .map((t) => {
      const marks = [t.active ? "active" : "", t.working ? "working" : ""].filter(Boolean).join(", ");
      return `[${t.id}] ${t.title || "(untitled)"} — ${t.url}${marks ? ` (${marks})` : ""}`;
    })
    .join("\n");
}

/**
 * 合并工具：一个模型可见工具代理多个扩展 RPC 名。
 * 能力开关（canExecute / isToolActive）按模型可见名判定，执行事实与账本仍按 RPC 名。
 */
const MODEL_TOOL_OF: Record<string, string> = {
  list_tabs: "tabs",
  get_active_tab: "tabs",
  open_tab: "tabs",
  switch_tab: "tabs",
  close_tab: "tabs",
  clear_marks: "mark",
  // worker_tabs 是扩展侧 RPC 名；模型可见的入口是常驻的 take_tab。
  worker_tabs: "take_tab",
};

export const modelToolOf = (rpcName: string): string => MODEL_TOOL_OF[rpcName] ?? rpcName;

export function createBrowserTools(rpc: ToolRpc, sessionId?: string, takeTab?: (tabId?: number) => Promise<unknown>, canExecute?: (name: ToolName) => boolean, execution?: { epoch: () => number; canWrite: () => boolean; assertCall?: (name: string, params: Record<string, unknown>, toolCallId?: string) => void; onStep?: (step: ProgramStep) => void }): ToolDefinition[] {
  const executionScope = new AsyncLocalStorage<{epoch: number; toolCallId: string}>();
  const sid = sessionId && !isLeadSession(sessionId) ? sessionId : undefined;
  // 通用 page JS 能绕过任何单个写工具的禁用，因此在写能力不完整时整体拒绝。
  // 依赖集合复用 WRITE_TOOLS（按模型可见名去重）；每次问真实 canExecute，不看 JS 内容或提示词。
  const unavailableWriteTools = (): ToolName[] =>
    canExecute ? [...new Set(WRITE_TOOLS.map((name) => modelToolOf(name)))].filter((name) => !canExecute(name as ToolName)) as ToolName[] : [];
  const assertGenericJsAllowed = () => {
    const missing = unavailableWriteTools();
    if (missing.length === 0) return;
    throw new Error(
      `通用页面 JS 不可用：工具 ${missing.join("、")} 当前未启用，操作未执行。请改用 snapshot 或 read_element 观察页面。`,
    );
  };
  const call = async (name: ToolName, params: Record<string, unknown>, programId?: string, stepId?: string) => {
    const scope = executionScope.getStore();
    const epoch = scope?.epoch;
    // SDK 调用身份（含 browser_run 子步骤）随 RPC 登记，执行事实才能沿真实事件回到任务账本。
    const sdkId = execution ? (stepId ?? scope?.toolCallId) : undefined;
    if (sdkId) rpc.ensureToolCall?.(sdkId, name, sid);
    if (execution && isWriteTool(name) && (!execution.canWrite() || epoch !== execution.epoch())) {
      if (sdkId) rpc.markCallRejected?.(sdkId);
      throw new Error("用户已补充或改变要求，旧步骤未执行。请读取最新用户输入并重新核对目标后继续。");
    }
    try {
      execution?.assertCall?.(name, params, sdkId);
    } catch (error) {
      if (sdkId) rpc.markCallRejected?.(sdkId);
      throw error;
    }
    if (name === "js") {
      try { assertGenericJsAllowed(); }
      catch (error) { if (sdkId) rpc.markCallRejected?.(sdkId); throw error; }
    }
    if (canExecute && !canExecute(modelToolOf(name) as ToolName)) {
      if (sdkId) rpc.markCallRejected?.(sdkId);
      throw new Error(`工具 ${modelToolOf(name)} 当前未启用，操作未执行`);
    }
    if (!sid && takeTab && (name === "switch_tab" || name === "close_tab")) {
      await takeTab(typeof params.tabId === "number" ? params.tabId : undefined);
    }
    const invoke = (executionEpoch?: number) => {
      // 未接线 SDK 身份时保持原有调用形状（兼容纯函数测试与外部调用）。
      if (sdkId === undefined) {
        if (executionEpoch !== undefined) return rpc.call(name, params, undefined, sid, programId, executionEpoch);
        return programId ? rpc.call(name, params, undefined, sid, programId) : rpc.call(name, params, undefined, sid);
      }
      return rpc.call(name, params, undefined, sid, programId, executionEpoch, sdkId);
    };
    if (execution && isWriteTool(name)) return invoke(epoch);
    return invoke(undefined);
  };

  const definitions = [
    defineTool({
      name: "page_operation",
      label: "Write and verify field",
      description: "Safely edit a field on a shared page. The executor serializes the complete re-locate, expected-value check, focus, fill and readback. Use a stable CSS target from a fresh snapshot, never old coordinates. Read expectedValue first. Failure reports any mutation; never assume rollback. Do not hold the page while thinking or waiting for messages.",
      parameters: Type.Object({
        tabId: Type.Optional(Type.Number()), target: Type.String(), expectedValue: Type.String(), value: Type.String(),
      }),
      execute: async (_id, params) => {
        const result = await call("page_operation", params);
        return textResult(JSON.stringify(result), result);
      },
    }),
    defineTool({
      name: "read_element",
      label: "Read complete element",
      description: "Read a unique current element without changing the page. By default return complete textContent and field value; use target:'body' for full source text. For controls/media use properties (paused, currentTime, checked, enabled, visible, expanded, pressed, value), not handwritten JS probes. To verify or wait, use expect:{property:'paused',equals:true} or expect:{property:'textContent',contains:'Saved'}, with timeoutMs up to 5000. Returns check.matched only when that exact condition holds; timeout is a failure, never success. Use a current snapshot @ref or unique observed native CSS; ambiguity/stale refs fail without switching targets. Works inside browser_run with the same parameters. Main may read any tab; workers only assigned tabs.",
      parameters: Type.Object({
        tabId: Type.Optional(Type.Number({ description: "Owned tab id; omit to use this member's working tab" })),
        target: Type.String({ description: 'Current "@N" snapshot ref, "loc=css:...", or unique native CSS selector' }),
        properties: Type.Optional(Type.Array(Type.Union(ELEMENT_PROPERTIES.map(p => Type.Literal(p))), { maxItems: ELEMENT_PROPERTIES.length, description: 'Read these state properties; omit for complete text/value. Unsupported properties fail explicitly.' })),
        expect: Type.Optional(Type.Union([
          Type.Object({ property: Type.Union(['visible','enabled','checked','selected','paused','ended'].map(p => Type.Literal(p))), equals: Type.Boolean({description:'Boolean true/false, never a quoted string.'}) }),
          Type.Object({ property: Type.Union([Type.Literal('expanded'),Type.Literal('pressed')]), equals: Type.Union([Type.Boolean(),Type.Literal('mixed')]) }),
          Type.Object({ property: Type.Union([Type.Literal('currentTime'),Type.Literal('duration')]), equals: Type.Number() }),
          Type.Object({ property: Type.Union([Type.Literal('textContent'),Type.Literal('value')]), equals: Type.String() }),
          Type.Object({ property: Type.Union([Type.Literal('textContent'), Type.Literal('value')]), contains: Type.String({ minLength: 1 }) }),
        ])),
        timeoutMs: Type.Optional(Type.Number({ minimum: 0, maximum: 5000, description: 'Optional bounded wait for expect; default 0 checks once. No model round trips while waiting.' })),
      }),
      execute: async (_id, params) => {
        const data = (await call("read_element", params)) as ToolContract["read_element"]["data"];
        // A state query does not need the element's entire descendant text in the model context.
        const projected = params.properties?.length || params.expect ? { tabId: data.tabId, target: data.target, tagName: data.tagName, properties: data.properties, check: data.check } : data;
        return textResult(wrapPageContent(redactCredentialText(JSON.stringify(projected)), { tabId: data.tabId }), data);
      },
    }),
    defineTool({
      name: "browser_run",
      label: "Browser program",
      description: 'Run an async JavaScript browser program. Only the browser object is available (no Node, process, require, fetch or document). Its methods use the SAME object parameters and return raw data from the regular tools: snapshot()->{text}, js({code})->{value}, hover/click({target or point}), fill({target,value}), and the other browser tools. browser.waitFor({selector,timeoutMs:5000}) waits for one visible enabled native-CSS target; browser.sleep({ms}) waits up to 10000ms. Use await for every operation and return JSON-serializable evidence. For one known action on a page you have not read yet, fold the observation into this same program (snapshot → pick the target → click → read back) instead of spending a separate round on snapshot. Prefer this for a known sequence with conditions/waits; observe first when targets are unknown. Page JavaScript belongs inside browser.js({code:"..."}). A held click, takeover or cancellation stops the entire program even if caught. Do not bypass confirmation or user control with page JS.',
      parameters: Type.Object({
        code: Type.String({ description: 'Async function body; await browser methods and return concise evidence. Example: await browser.hover({target:"#card"}); await browser.waitFor({selector:"#edit"}); await browser.click({target:"#edit"}); return (await browser.snapshot()).text;' }),
        label: Type.Optional(Type.String({ description: "Short user-facing goal for this sequence" })),
      }),
      execute: async (id, params, signal, onUpdate) => {
        // 组合调用一旦开始，整体结果就不再是“确定未执行”。
        rpc.noteToolFact?.(id, "unknown");
        const result = await runBrowserProgram({ code: params.code,
          call: (name, args, stepId) => call(name, args, id, stepId), signal, id,
          // Preflight needs the substep binding now, not after Pi's async progress queue drains.
          onStep: programStep => execution?.onStep ? execution.onStep(programStep) : onUpdate?.({ content: [], details: { programStep } }),
        });
        rpc.noteToolFact?.(id, "executed");
        return { content: [{ type: "text" as const, text: truncate(JSON.stringify({ value: result.value, steps: result.steps }), MAX_JS_RESULT_CHARS) }, ...result.images], details: { value: result.value, steps: result.steps } };
      },
    }),

    defineTool({
      name: "tabs",
      label: "Tabs",
      description:
        sid
          ? 'One tool for browser tabs. action:"list" lists the tabs assigned to you; other members\' and user tabs are not available to workers.'
          : 'One tool for browser tabs, in one call: action:"list" lists ALL tabs (id, title, URL) including user-opened and other conversations\' — reading does not claim them; action:"active" returns the tab the user is looking at right now (use it for "this page" when the message carries no page context, then action:"switch"); action:"open" opens url (omit for blank) and claims it as the working tab; action:"switch" makes tabId the working tab; action:"close" closes tabId or the working tab. Open returns when the document is interactive, not when all resources finish; a readiness timeout is not confirmed success — check the URL and snapshot before acting.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("active"), Type.Literal("open"), Type.Literal("switch"), Type.Literal("close")], {
          description: "list | active | open | switch | close",
        }),
        tabId: Type.Optional(Type.Number({ description: 'Tab id (required for "switch"; optional for "close", which defaults to the working tab)' })),
        url: Type.Optional(Type.String({ description: 'URL to open for "open"; omit for a blank tab' })),
      }),
      execute: async (_id, params) => {
        if (params.action === "list") {
          const data = (await call("list_tabs", {})) as ToolContract["list_tabs"]["data"];
          return textResult(formatTabs(data.tabs), data);
        }
        if (params.action === "active") {
          const data = (await call("get_active_tab", {})) as ToolContract["get_active_tab"]["data"];
          if (!data.tab) return textResult("No active tab found.", data);
          return textResult(formatTabs([data.tab]), data);
        }
        if (params.action === "open") {
          const data = (await call("open_tab", params.url ? { url: params.url } : {})) as ToolContract["open_tab"]["data"];
          return textResult(`Created tab ${data.tabId}: ${data.title || "(loading)"} — ${data.url}; document: ${data.readiness ?? "not checked"}`, data);
        }
        if (params.action === "switch") {
          if (typeof params.tabId !== "number") throw new Error('tabs action:"switch" 需要 tabId。');
          const data = (await call("switch_tab", { tabId: params.tabId })) as ToolContract["switch_tab"]["data"];
          return textResult(`Working tab is now ${data.tabId}.`, data);
        }
        const data = (await call("close_tab", typeof params.tabId === "number" ? { tabId: params.tabId } : {})) as ToolContract["close_tab"]["data"];
        return textResult("Tab closed.", data);
      },
    }),

    defineTool({
      name: "navigate",
      label: "Navigate",
      description: "Navigate the working tab to a URL and wait for the new document to be interactive. Readiness timeout is not confirmed navigation success; verify the URL and take a snapshot before acting.",
      parameters: Type.Object({
        url: Type.String({ description: "Absolute URL" }),
        timeout: Type.Optional(Type.Number({ description: "Load timeout in seconds" })),
      }),
      execute: async (_id, params) => {
        const data = (await call("navigate", params)) as ToolContract["navigate"]["data"];
        return textResult(`Navigation result: ${data.url} — ${data.title}; document: ${data.readiness ?? "not checked"}`, data);
      },
    }),

    defineTool({
      name: "snapshot",
      label: "Snapshot",
      description:
        "Read a tab as indented text. Main can pass any tabId without taking control; omit tabId for the working tab. Workers can read only assigned tabs. scope=full_page (default): the real CDP accessibility tree (covers shadow DOM and virtualized content); rendered content (including headings, text, images and controls) carries [ref=N] when backed by a DOM node (= backendDOMNodeId, CDP path). scope=viewport: a viewport-only simplified DOM snapshot (downgrade, not the full AX tree); its refs are DOM snapshot numbers valid only via the DOM path — do not mix them with older AX refs. This is your primary way to observe the page.",
      promptGuidelines: [
        "Take a snapshot after every navigation and after actions that change the page.",
        "Ref numbers are stable for persistent nodes, but @N must appear in the latest snapshot. A new snapshot replaces the available ref set; navigation or node replacement invalidates old refs.",
        "Viewport snapshots return a different (DOM) ref space; never reuse full_page AX refs after a viewport snapshot.",
      ],
      parameters: Type.Object({
        tabId: Type.Optional(Type.Number({ description: "Tab to read without claiming or switching it" })),
        scope: Type.Optional(
          Type.Union([Type.Literal("full_page"), Type.Literal("viewport")], {
            description: "full_page (default) or viewport only",
          }),
        ),
      }),
      execute: async (_id, params) => {
        const data = (await call("snapshot", params)) as ToolContract["snapshot"]["data"];
        return textResult(wrapPageContent(redactCredentialText(data.text), { tabId: data.tabId }), data);
      },
    }),

    defineTool({
      name: "hover",
      label: "Hover",
      description:
        'Move the real browser mouse over an element to reveal hover-only controls, menus or tooltips. Provide target ("@N" from the latest snapshot, "loc=css:...", or native CSS) or viewport point [x,y]. Then observe which controls appeared before clicking. JavaScript-dispatched mouse events do not activate CSS :hover.',
      parameters: Type.Object({
        target: Type.Optional(Type.String({ description: '"@N" from the latest snapshot, "loc=css:...", or native CSS; no :has-text()' })),
        point: Type.Optional(Type.Tuple([Type.Number(), Type.Number()], { description: "Viewport [x, y] coordinates" })),
        label: Type.Optional(Type.String({ description: "Short description of the hover target" })),
      }),
      execute: async (_id, params) => {
        const data = await call("hover", params);
        const what = params.label ?? params.target ?? (params.point ? `(${params.point[0]}, ${params.point[1]})` : "element");
        return textResult(`Mouse moved over ${what}. Observe the page to check whether the intended control appeared.`, data);
      },
    }),

    defineTool({
      name: "click",
      label: "Click",
      description:
        'Click an element in the working tab. Provide target ("@N" ref, "loc=css:..." locator, or a raw CSS selector) or point [x, y] viewport coordinates. The result reports whether the page reacted (target state, target region, new notices) and says explicitly when nothing is attributable to the click.',
      parameters: Type.Object({
        target: Type.Optional(
          Type.String({ description: '"@N" ref, "loc=css:..." locator, or raw CSS selector' }),
        ),
        point: Type.Optional(
          Type.Tuple([Type.Number(), Type.Number()], { description: "Viewport [x, y] coordinates" }),
        ),
        label: Type.Optional(Type.String({ description: "Short human-readable description of what you click" })),
      }),
      execute: async (_id, params) => {
        const data = (await call("click", params)) as ToolContract["click"]["data"];
        const what = params.label ?? params.target ?? (params.point ? `(${params.point[0]}, ${params.point[1]})` : "element");
        if ("held" in data && data.held) {
          return textResult(
            `Held click on ${what}. The cursor is holding the target with confirm/cancel buttons on its name pill. Wait for the user. Do not click the site's own delete control again, and do not claim you already marked it.`,
            data,
          );
        }
        const effectText = formatEffectReport("effect" in data ? data.effect : undefined);
        const opened = "newTab" in data ? data.newTab : undefined;
        const newTabText = opened ? ` A new tab opened (tab ${opened.tabId}${opened.url ? `, ${opened.url}` : ""}) and it is now your working tab; observe it before continuing.` : "";
        if (effectText) {
          return textResult(`Clicked ${what}. Event dispatch confirmed.${effectText}${newTabText}`, data);
        }
        return textResult(`Clicked ${what}. This confirms event dispatch only; observe the page to verify the intended change before continuing or reporting success.${newTabText}`, data);
      },
    }),

    defineTool({
      name: "fill",
      label: "Fill",
      description:
        "Set the value of an input/textarea in the working tab (works with controlled components). target accepts the same locator forms as click.",
      parameters: Type.Object({
        target: Type.String({ description: '"@N" ref, "loc=css:..." locator, or raw CSS selector' }),
        value: Type.String({ description: "Value to set" }),
      }),
      execute: async (_id, params) => {
        const data = (await call("fill", params)) as ToolContract["fill"]["data"];
        return textResult(`Filled ${params.target}.`, data);
      },
    }),

    defineTool({
      name: "type_text",
      label: "Type text",
      description: "Type text as real keyboard input into the currently focused element of the working tab.",
      parameters: Type.Object({
        text: Type.String({ description: "Text to type" }),
      }),
      execute: async (_id, params) => {
        const data = (await call("type_text", params)) as ToolContract["type_text"]["data"];
        return textResult(`Typed ${params.text.length} character(s).`, data);
      },
    }),

    defineTool({
      name: "press_key",
      label: "Press key",
      description: "Press a key in the working tab, e.g. Enter, Tab, Escape, ArrowDown, or combos like Control+A.",
      parameters: Type.Object({
        key: Type.String({ description: 'Key name or combo, e.g. "Enter", "Tab", "Control+A"' }),
      }),
      execute: async (_id, params) => {
        const data = (await call("press_key", params)) as ToolContract["press_key"]["data"];
        return textResult(`Pressed ${params.key}.`, data);
      },
    }),

    defineTool({
      name: "scroll",
      label: "Scroll",
      description:
        "Scroll the working tab by dy pixels (positive = down) or jump to the bottom. Re-snapshot afterwards to see new content.",
      parameters: Type.Object({
        dy: Type.Optional(Type.Number({ description: "Pixels to scroll, positive down" })),
        toBottom: Type.Optional(Type.Boolean({ description: "Scroll to the very bottom" })),
      }),
      execute: async (_id, params) => {
        const data = (await call("scroll", params)) as ToolContract["scroll"]["data"];
        return textResult(data.atBottom ? "Scrolled; reached the bottom." : "Scrolled.", data);
      },
    }),

    defineTool({
      name: "fetch",
      label: "Fetch URL with the browser's login state",
      description:
        "Fetch a URL with the browser's logged-in state (cookies), without touching the page. Only GET and POST; local/private addresses are refused. Use it to read structured data through the site's own API instead of scraping a snapshot: fields keep the site's real names. Large responses (>4000 chars) are saved under ~/.sideagent/downloads/ and only a status line plus a short preview enters the context; pass savePath to choose the file name. For a numeric page range use pages:{from,to,step?} with a {page} placeholder in the url (or POST body): one call fetches the pages in order, saves one file per page, and returns a compact receipt with only the first page's preview. pages is a companion-process feature of this tool only; inside browser_run, call browser.fetch once per page and combine the results in the program. The saved file is the user's own data and is not redacted; anything shown in context is treated as untrusted page content.",
      parameters: Type.Object({
        url: Type.String({ description: "Full http(s) URL, including query parameters; use {page} as the page placeholder" }),
        method: Type.Optional(Type.Union([Type.Literal("GET"), Type.Literal("POST")], { description: "Default GET" })),
        headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra request headers; Cookie is set by the browser" })),
        body: Type.Optional(Type.String({ description: "POST body (string); {page} is substituted here too" })),
        savePath: Type.Optional(Type.String({ description: "File name under ~/.sideagent/downloads/ (no directories); with pages it is the base name and -p<page> is inserted before the extension" })),
        pages: Type.Optional(Type.Object({
          from: Type.Integer({ description: "First page number" }),
          to: Type.Integer({ description: "Last page number (inclusive)" }),
          step: Type.Optional(Type.Integer({ description: "Page step, default 1; at most 20 pages per call" })),
        }, { description: "Fetch a numeric page range in one call; requires {page} in url or body" })),
      }),
      execute: async (_id, params) => {
        if (params.pages) {
          const batch = await fetchPages(
            { url: params.url, method: params.method, headers: params.headers, body: params.body, savePath: params.savePath, pages: params.pages },
            (request) => call("fetch", request) as Promise<FetchReply>,
          );
          return textResult(wrapPageContent(batch.text, { url: params.url }), batch.data);
        }
        const data = (await call("fetch", params)) as ToolContract["fetch"]["data"];
        return textResult(formatFetchReply(data as FetchReply, params.savePath), data);
      },
    }),

    defineTool({
      name: "network",
      label: "Observed network requests",
      description:
        "List the recent network requests the working tab actually made (passive CDP recording while the extension observes the tab): method, URL, status, resource type, size and duration. Use it to find the site's own JSON API before scraping the DOM, then call fetch on that URL with the browser's login state. Defaults to API-like requests (xhr/fetch); pass types:\"all\" for documents, scripts, images and the rest. Recorded per tab, survives navigation and keeps going while the debugger is attached; the buffer is memory-only and empty after the extension restarts. No bodies, headers or cookies are recorded. Use clear:true before triggering the action you want to observe, then read again.",
      parameters: Type.Object({
        urlContains: Type.Optional(Type.String({ description: "Only show URLs containing this text (case-insensitive)" })),
        types: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Literal("all")], { description: "Resource types to show; default xhr/fetch, 'all' for everything" })),
        limit: Type.Optional(Type.Number({ description: "Show at most the last N matches (default 40, max 200)" })),
        tabId: Type.Optional(Type.Number({ description: "Tab to read without claiming or switching it" })),
        clear: Type.Optional(Type.Boolean({ description: "Empty this tab's buffer first, then report the clear" })),
      }),
      execute: async (_id, params) => {
        const data = (await call("network", params)) as ToolContract["network"]["data"];
        return textResult(wrapPageContent(redactCredentialText(data.text), { tabId: data.tabId }), data);
      },
    }),

    defineTool({
      name: "js",
      label: "Run JavaScript",
      description:
        "Evaluate a JavaScript expression in the working tab and get its value. Invoke functions explicitly: (() => { return document.title; })(). A bare () => {...} only creates a function and does not execute its body. Prefer one invoked IIFE that extracts everything you need over multiple round trips.",
      promptGuidelines: ["Wrap code in a single IIFE that returns a JSON-serializable value."],
      parameters: Type.Object({
        code: Type.String({ description: "JavaScript to evaluate; use an IIFE with a return value" }),
      }),
      execute: async (_id, params) => {
        const data = (await call("js", params)) as ToolContract["js"]["data"];
        const rendered = data.value === undefined
          ? "JavaScript returned undefined. No observable value was returned; this does not confirm a page change. For extraction, use one IIFE with an explicit return of JSON-serializable findings. For hover-only controls, use hover, then observe the page."
          : wrapPageContent(redactCredentialText(truncate(typeof data.value === "string" ? data.value : JSON.stringify(data.value, null, 2), MAX_JS_RESULT_CHARS)));
        return textResult(rendered, data);
      },
    }),

    defineTool({
      name: "mark",
      label: "Mark elements",
      description:
        "Draw or clear annotations on the working tab. Draw: a persistent hand-drawn outline + pointer arrow + optional label on target (\"look here\", highlights). For irreversible confirmation, pass actions: the cursor flies over and grabs the element, and the user clicks 删除/取消 on the cursor's name pill instead of only typing in the sidebar. The mark is anchored to the document, so it stays on its target when the user scrolls. target accepts the same locator forms as click. Marks persist until cleared or page navigation (clear:true removes all marks). Prefer the specific content ref from the latest snapshot (text refs mark the text bounds). Do not infer CSS sibling positions from snapshot order. Never use body/html as a placeholder for an object.",
      parameters: Type.Object({
        target: Type.Optional(Type.String({ description: '"@N" ref, "loc=css:..." locator, or raw CSS selector; required unless clear is true' })),
        label: Type.Optional(Type.String({ description: "Short label shown next to the mark, e.g. 待删除" })),
        actions: Type.Optional(
          Type.Array(
            Type.Object({
              id: Type.Union([Type.Literal("confirm"), Type.Literal("cancel")]),
              label: Type.String({ description: "Button text, e.g. 删除 / 取消" }),
            }),
            { maxItems: 2, description: "Confirm/cancel buttons shown on the cursor's name pill while it holds the marked element (draw only)" },
          ),
        ),
        clear: Type.Optional(Type.Boolean({ description: "true clears every mark on the page instead of drawing; no target needed" })),
      }),
      execute: async (_id, params) => {
        if (params.clear === true) {
          const data = (await call("clear_marks", {})) as ToolContract["clear_marks"]["data"];
          return textResult("All marks cleared.", data);
        }
        if (typeof params.target !== "string" || !params.target.trim()) throw new Error("mark 需要 target；只想清除标注时传 clear:true。");
        const data = (await call("mark", { target: params.target, label: params.label, actions: params.actions })) as ToolContract["mark"]["data"];
        return textResult(`Marked ${params.target}.`, data);
      },
    }),

    defineTool({
      name: "screenshot",
      label: "Screenshot",
      description:
        "Capture a screenshot of the working tab. The result states the tab id/URL, the capture source, image pixels and the CSS viewport with DPR: click/point coordinates use CSS pixels (image_px / DPR ≈ css_px when the page fills the viewport). Fallback perception for canvas, complex visuals, or when a snapshot is not informative enough; prefer snapshot otherwise (cheaper).",
      parameters: Type.Object({}),
      execute: async () => {
        const data = (await call("screenshot", {})) as ToolContract["screenshot"]["data"];
        const geometry =
          data.cssWidth > 0
            ? ` Image pixels ${data.pixelWidth}x${data.pixelHeight}; CSS viewport ${data.cssWidth}x${data.cssHeight} @ DPR ${data.devicePixelRatio} — click/point coordinates use CSS pixels.`
            : ` Image pixels ${data.pixelWidth}x${data.pixelHeight} (CSS viewport unknown; do not convert coordinates from this image).`;
        return {
          content: [
            {
              type: "text" as const,
              text: `Screenshot of working tab ${data.tabId} (${data.title || "(untitled)"} — ${data.url}) via ${data.source}.${geometry}`,
            },
            { type: "image" as const, data: data.imageBase64, mimeType: data.mediaType },
          ],
          details: data,
        };
      },
    }),
  ];
  return execution ? definitions.map(tool => ({ ...tool, execute: (...args: Parameters<ToolDefinition["execute"]>) => executionScope.run({epoch: execution.epoch(), toolCallId: args[0]}, async () => {
    const rpcWithFacts = rpc as Partial<Pick<ToolRpc, "ensureToolCall" | "markCallRejected">>;
    rpcWithFacts.ensureToolCall?.(args[0], tool.name as ToolName, sid);
    try {
      return await (tool as ToolDefinition).execute(...args);
    } catch (error) {
      rpcWithFacts.markCallRejected?.(args[0]);
      throw error;
    }
  }) })) : definitions;
}
