/**
 * 16 个浏览器工具的 defineTool 封装。
 * 每个 execute 只做一件事：rpc.call 转发给扩展，再把结果转成模型友好的 content。
 * 工具名严格对齐 shared/protocol.ts 的 TOOL_NAMES / ToolContract。
 * 教学模式不裁剪工具能力（教学倾向由 prompt 层表达），全部工具始终可用。
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isLeadSession, type TabInfo, type ToolContract, type ToolName } from "../../shared/protocol.js";
import type { ToolRpc } from "./rpc.js";

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

export function createBrowserTools(rpc: ToolRpc, sessionId?: string): ToolDefinition[] {
  const sid = sessionId && !isLeadSession(sessionId) ? sessionId : undefined;
  const call = (name: ToolName, params: Record<string, unknown>) => rpc.call(name, params, undefined, sid);

  return [
    defineTool({
      name: "list_tabs",
      label: "List tabs",
      description:
        "List all open browser tabs with id, title and url. Marks the active tab and your current working tab.",
      parameters: Type.Object({}),
      execute: async () => {
        const data = (await call("list_tabs", {})) as ToolContract["list_tabs"]["data"];
        return textResult(formatTabs(data.tabs), data);
      },
    }),

    defineTool({
      name: "get_active_tab",
      label: "Get active tab",
      description:
        'Get the tab the user is currently looking at (the browser\'s focused tab), or null if there is none. Use it to resolve references like "this page" when the user message carries no page context. Pure query — does not claim the tab; call switch_tab to work on it.',
      parameters: Type.Object({}),
      execute: async () => {
        const data = (await call("get_active_tab", {})) as ToolContract["get_active_tab"]["data"];
        if (!data.tab) return textResult("No active tab found.", data);
        return textResult(formatTabs([data.tab]), data);
      },
    }),

    defineTool({
      name: "open_tab",
      label: "Open tab",
      description:
        "Open a new tab and claim it as the working tab. Omit url for a blank tab, then use navigate.",
      parameters: Type.Object({
        url: Type.Optional(Type.String({ description: "URL to open" })),
      }),
      execute: async (_id, params) => {
        const data = (await call("open_tab", params)) as ToolContract["open_tab"]["data"];
        return textResult(`Opened tab ${data.tabId}: ${data.title || "(loading)"} — ${data.url}`, data);
      },
    }),

    defineTool({
      name: "switch_tab",
      label: "Switch tab",
      description: "Switch the working tab to an existing tab (from list_tabs). Subsequent tools act on it.",
      parameters: Type.Object({
        tabId: Type.Number({ description: "Tab id from list_tabs" }),
      }),
      execute: async (_id, params) => {
        const data = (await call("switch_tab", params)) as ToolContract["switch_tab"]["data"];
        return textResult(`Working tab is now ${data.tabId}.`, data);
      },
    }),

    defineTool({
      name: "close_tab",
      label: "Close tab",
      description: "Close the working tab, or a specific tab when tabId is given.",
      parameters: Type.Object({
        tabId: Type.Optional(Type.Number({ description: "Tab id; omit to close the working tab" })),
      }),
      execute: async (_id, params) => {
        const data = (await call("close_tab", params)) as ToolContract["close_tab"]["data"];
        return textResult("Tab closed.", data);
      },
    }),

    defineTool({
      name: "navigate",
      label: "Navigate",
      description: "Navigate the working tab to a URL and wait for load. Take a snapshot afterwards.",
      parameters: Type.Object({
        url: Type.String({ description: "Absolute URL" }),
        timeout: Type.Optional(Type.Number({ description: "Load timeout in seconds" })),
      }),
      execute: async (_id, params) => {
        const data = (await call("navigate", params)) as ToolContract["navigate"]["data"];
        return textResult(`Navigated to ${data.url} — ${data.title}`, data);
      },
    }),

    defineTool({
      name: "snapshot",
      label: "Snapshot",
      description:
        "Get the real accessibility tree of the working tab as indented text (via CDP: covers shadow DOM and virtualized content). Interactive elements are listed as [ref=N]. This is your primary way to observe the page.",
      promptGuidelines: [
        "Take a snapshot after every navigation and after actions that change the page.",
        "@N refs stay valid across snapshots while the node persists; navigation invalidates them.",
      ],
      parameters: Type.Object({
        scope: Type.Optional(
          Type.Union([Type.Literal("full_page"), Type.Literal("viewport")], {
            description: "full_page (default) or viewport only",
          }),
        ),
      }),
      execute: async (_id, params) => {
        const data = (await call("snapshot", params)) as ToolContract["snapshot"]["data"];
        return textResult(data.text, data);
      },
    }),

    defineTool({
      name: "click",
      label: "Click",
      description:
        'Click an element in the working tab. Provide target ("@N" ref, "loc=css:..." locator, or a raw CSS selector) or point [x, y] viewport coordinates.',
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
        return textResult(`Clicked ${what}.`, data);
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
      name: "js",
      label: "Run JavaScript",
      description:
        "Run JavaScript in the working tab and get the returned value. Prefer one IIFE that extracts everything you need over multiple round trips.",
      promptGuidelines: ["Wrap code in a single IIFE that returns a JSON-serializable value."],
      parameters: Type.Object({
        code: Type.String({ description: "JavaScript to evaluate; use an IIFE with a return value" }),
      }),
      execute: async (_id, params) => {
        const data = (await call("js", params)) as ToolContract["js"]["data"];
        const rendered =
          typeof data.value === "string" ? data.value : truncate(JSON.stringify(data.value, null, 2) ?? "undefined", MAX_JS_RESULT_CHARS);
        return textResult(rendered, data);
      },
    }),

    defineTool({
      name: "mark",
      label: "Mark element",
      description:
        "Draw a persistent annotation on an element in the working tab: outline box + pointer arrow + optional label. Use it to point out key content to the user (\"look here\", highlights). For irreversible confirmation, pass actions so the user can click 删除/取消 on the page (outside the box) instead of only typing in the sidebar. The mark is anchored to the document, so it stays on its target when the user scrolls. target accepts the same locator forms as click. Marks persist until clear_marks or page navigation.",
      parameters: Type.Object({
        target: Type.String({ description: '"@N" ref, "loc=css:..." locator, or raw CSS selector' }),
        label: Type.Optional(Type.String({ description: "Short label shown next to the mark, e.g. 待删除" })),
        actions: Type.Optional(
          Type.Array(
            Type.Object({
              id: Type.Union([Type.Literal("confirm"), Type.Literal("cancel")]),
              label: Type.String({ description: "Button text, e.g. 删除 / 取消" }),
            }),
            { maxItems: 2, description: "On-page confirm/cancel buttons rendered outside the mark box" },
          ),
        ),
      }),
      execute: async (_id, params) => {
        const data = (await call("mark", params)) as ToolContract["mark"]["data"];
        return textResult(`Marked ${params.target}.`, data);
      },
    }),

    defineTool({
      name: "clear_marks",
      label: "Clear marks",
      description: "Remove all annotation marks previously drawn with mark.",
      parameters: Type.Object({}),
      execute: async () => {
        const data = (await call("clear_marks", {})) as ToolContract["clear_marks"]["data"];
        return textResult("All marks cleared.", data);
      },
    }),

    defineTool({
      name: "screenshot",
      label: "Screenshot",
      description:
        "Capture a screenshot of the working tab. Fallback perception for canvas, complex visuals, or when a snapshot is not informative enough; prefer snapshot otherwise (cheaper).",
      parameters: Type.Object({}),
      execute: async () => {
        const data = (await call("screenshot", {})) as ToolContract["screenshot"]["data"];
        return {
          content: [
            { type: "text" as const, text: `Screenshot of the working tab (${data.width}x${data.height}).` },
            { type: "image" as const, data: data.imageBase64, mimeType: data.mediaType },
          ],
          details: data,
        };
      },
    }),
  ];
}
