import { randomUUID } from "node:crypto";
import type { launchRealPath } from "./harness.mts";

type Browser = Awaited<ReturnType<typeof launchRealPath>>;
type Rect = { x: number; y: number; width: number; height: number };
export type MarkCapture = {
  marks: Array<{ at: number; rect: Rect; target: Rect | null }>;
  interactions: Array<{ at: number; type: string }>;
};

/** Observe the extension's closed shadow root without exposing or modifying it. */
export async function installMarkTiming(rp: Browser, panel: string, page: string, pageUrl: string, targetSelector = "#size-chart"): Promise<void> {
  const token = randomUUID();
  await rp.evaluate(page, `(() => {
    const capture = window.__markTiming = { marks: [], interactions: [] };
    for (const type of ["click", "input"]) document.addEventListener(type, () => {
      capture.interactions.push({ at: Date.now(), type });
    }, true);
    window.addEventListener("message", event => {
      if (event.source !== window || event.data?.token !== ${JSON.stringify(token)} || event.data?.kind !== "mark") return;
      const target = document.querySelector(${JSON.stringify(targetSelector)})?.getBoundingClientRect();
      capture.marks.push({ at: event.data.at, rect: event.data.rect, target: target ? { x: target.x, y: target.y, width: target.width, height: target.height } : null });
    });
    return true;
  })()`);
  await rp.evaluate(panel, `(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(item => item.url === ${JSON.stringify(pageUrl)});
    if (!tab?.id) throw new Error("没有找到圈画练习页");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "ISOLATED", args: [${JSON.stringify(token)}], func: token => {
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(init) {
        const root = attach.call(this, init);
        new MutationObserver(records => {
          for (const record of records) for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            const marks = node.matches(".mark") ? [node] : [...node.querySelectorAll(".mark")];
            for (const mark of marks) {
              const rect = mark.getBoundingClientRect();
              window.postMessage({ token, kind: "mark", at: Date.now(),
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }, location.origin);
            }
          }
        }).observe(root, { subtree: true, childList: true });
        return root;
      };
    } });
    return true;
  })()`);
}

export async function readMarkTiming(rp: Browser, page: string): Promise<MarkCapture> {
  return await rp.evaluate(page, "window.__markTiming") as MarkCapture;
}

export type ReadOnlyCapture = {
  materialInDom: boolean;
  pageUnchanged: boolean;
  mutations: Array<{ at: number; type: string }>;
  interactions: Array<{ at: number; type: string }>;
  tasks: Array<{ at: number; kind: string }>;
};

export async function installReadOnlyTiming(rp: Browser, panel: string, page: string): Promise<void> {
  await rp.evaluate(page, `(() => {
    const initial = document.body.innerHTML, x = scrollX, y = scrollY;
    const capture = window.__readOnlyPage = { materialInDom: document.documentElement.outerHTML.includes("耐磨橡胶"), mutations: [], interactions: [] };
    new MutationObserver(records => {
      for (const record of records) capture.mutations.push({ at: Date.now(), type: record.type });
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    for (const type of ["click", "input"]) document.addEventListener(type, () => {
      capture.interactions.push({ at: Date.now(), type });
    }, true);
    window.__readOnlyPageResult = () => ({ ...capture, pageUnchanged: initial === document.body.innerHTML && x === scrollX && y === scrollY });
    return true;
  })()`);
  await rp.evaluate(panel, `(() => {
    const capture = window.__readOnlyTasks = [];
    let running = false;
    new MutationObserver(records => {
      const now = Date.now();
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches(".ai-task-card") || node.querySelector(".ai-task-card"))) capture.push({ at: now, kind: "task-card" });
      }
      const next = !!document.querySelector("#status-pill.running, #send-btn.stopping");
      if (next && !running) capture.push({ at: now, kind: "task-running" });
      running = next;
    }).observe(document, { subtree: true, childList: true, attributes: true });
    return true;
  })()`);
}

export async function readReadOnlyTiming(rp: Browser, panel: string, page: string): Promise<ReadOnlyCapture> {
  const pageCapture = await rp.evaluate(page, "window.__readOnlyPageResult()") as Omit<ReadOnlyCapture, "tasks">;
  const tasks = await rp.evaluate(panel, "window.__readOnlyTasks") as ReadOnlyCapture["tasks"];
  return { ...pageCapture, tasks };
}

export type TaskCapture = {
  cards: Array<{ at: number; runId: string; text: string }>;
  checks: Array<{ at: number; runId: string; text: string }>;
};

export async function installTaskTiming(rp: Browser, panel: string): Promise<void> {
  await rp.evaluate(panel, `(() => {
    const capture = window.__taskTiming = { cards: [], checks: [] };
    const cards = new Set(), checks = new Set();
    const visible = node => node && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden";
    const observe = () => {
      for (const node of document.querySelectorAll(".ai-task-card")) {
        const runId = node.dataset.runId ?? "";
        if (!runId || cards.has(runId) || !visible(node)) continue;
        cards.add(runId);
        capture.cards.push({ at: Date.now(), runId, text: (node.textContent ?? "").trim().slice(0, 300) });
      }
      for (const node of document.querySelectorAll(".run-check")) {
        const text = (node.textContent ?? "").trim();
        const runId = node.closest("details.run-steps")?.dataset.runId ?? "";
        const key = runId + ":" + text;
        if (!text.includes("已核对页面") || checks.has(key) || !visible(node)) continue;
        checks.add(key);
        capture.checks.push({ at: Date.now(), runId, text });
      }
    };
    new MutationObserver(observe).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    observe();
    return true;
  })()`);
}

export async function readTaskTiming(rp: Browser, panel: string): Promise<TaskCapture> {
  return await rp.evaluate(panel, "window.__taskTiming") as TaskCapture;
}
