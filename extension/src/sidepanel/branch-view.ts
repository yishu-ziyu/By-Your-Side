/**
 * 过程块进行中的分叉层：挂在 summary 下面，不改 A+C 两行。
 * 只有并行、重试死路、接管才出现；单步回合这里是空的。
 */
import { siteGlyph } from "./answer-actions.js";
import {
  FOLD_HOLD_MS,
  FOLD_MS,
  FORK_MS,
  FORK_STAGGER_MS,
  MAX_LANES,
  MAX_TABS,
  MERGE_MS,
  PROCESS_MAX_PX,
  classifyKind,
  clipReason,
  groupSummary,
  hostOfUrl,
  reducedMotion,
  type GraphKind,
  type GraphTool,
} from "./branch-graph.js";

export type LiveGraph = {
  el: HTMLElement;
  start: (tool: GraphTool) => void;
  end: (id: string, update: Partial<Pick<GraphTool, "failed" | "reason" | "result" | "label">>) => void;
  user: (on: boolean) => void;
};

type Group = {
  root: HTMLElement;
  kind: GraphKind;
  tools: GraphTool[];
  rows: Map<string, HTMLElement>;
  fold: HTMLElement;
  timer: number;
};

export function mountLiveGraph(opts: { history: () => boolean }): LiveGraph {
  const el = document.createElement("div");
  el.className = "run-live-graph";
  el.hidden = true;
  const open: GraphTool[] = [];
  const groups: Group[] = [];
  let current: Group | null = null;
  let you: Group | null = null;
  let lastDead: GraphTool | null = null;
  let burst: GraphTool[] = [];
  let burstTimer = 0;
  const BURST_MS = 280;

  const show = () => {
    el.hidden = groups.length === 0;
    el.style.maxHeight = `${PROCESS_MAX_PX}px`;
  };

  const startGroup = (kind: GraphKind, tools: GraphTool[]): Group => {
    const root = document.createElement("div");
    root.className = "run-graph-group";
    root.dataset.kind = kind;
    root.dataset.state = "live";
    root.dataset.forkMs = String(FORK_MS);
    root.dataset.mergeMs = String(MERGE_MS);
    root.dataset.foldHoldMs = String(FOLD_HOLD_MS);
    root.dataset.foldMs = String(FOLD_MS);
    const rows = document.createElement("div");
    rows.className = kind === "b3" ? "run-graph-fan" : "run-graph-rows";
    const fold = document.createElement("button");
    fold.type = "button";
    fold.className = "run-graph-fold";
    fold.hidden = true;
    fold.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const openFold = root.dataset.state === "folded";
      root.dataset.state = openFold ? "live" : "folded";
      fold.hidden = openFold;
      rows.hidden = !openFold;
    });
    root.append(rows, fold);
    const group: Group = { root, kind, tools, rows: new Map(), fold, timer: 0 };
    for (const tool of tools) addLane(group, tool, group.tools.indexOf(tool));
    for (const other of groups) {
      if (other.root.dataset.state === "live" || other.root.dataset.state === "merging") {
        other.root.dataset.state = "folded";
        if (!other.fold.textContent) other.fold.textContent = `${groupSummary(other.kind, other.tools)} ›`;
        other.fold.hidden = false;
        const rows = other.root.querySelector(".run-graph-rows, .run-graph-fan") as HTMLElement | null;
        if (rows) rows.hidden = true;
        window.clearTimeout(other.timer);
        other.timer = 0;
      }
    }

    current = group;
    groups.push(group);
    el.append(root);
    pack();
    show();

    return group;
  };

  const pack = () => {
    const busy = groups.some((g) => g.root.dataset.state === "live" || g.root.dataset.state === "merging" || g.root.dataset.state === "folding");
    for (const g of groups) g.root.hidden = busy && g.root.dataset.state === "folded";
  };

  const addLane = (group: Group, tool: GraphTool, index: number): void => {
    const shown = index < (group.kind === "b3" ? MAX_TABS : MAX_LANES);
    const extra = index - (group.kind === "b3" ? MAX_TABS : MAX_LANES) + 1;
    if (!shown && extra > 1) {
      const more = group.root.querySelector(".run-graph-more");
      if (more) more.textContent = `+${extra}`;

      return;
    }

    const row = document.createElement(group.kind === "b3" ? "span" : "div");
    row.className = group.kind === "b3" ? "run-tab-tile" : "run-graph-row";
    row.dataset.id = tool.id;
    row.dataset.state = tool.failed ? "dead" : "running";
    row.style.setProperty("--i", String(index));
    row.style.setProperty("--lanes", String(Math.min(group.tools.length, group.kind === "b3" ? MAX_TABS : MAX_LANES)));
    row.style.animationDelay = reducedMotion() ? "0ms" : `${index * FORK_STAGGER_MS}ms`;
    if (!shown) {
      row.className = "run-graph-more";
      row.textContent = `+${extra}`;
      group.root.querySelector(group.kind === "b3" ? ".run-graph-fan" : ".run-graph-rows")!.append(row);
      group.rows.set(tool.id, row);

      return;
    }

    if (group.kind === "b3") {
      const host = tool.host ?? "页";
      const glyph = tool.url ? siteGlyph(tool.url, host) : letterGlyph(host);
      glyph.classList.add("run-tab-glyph");
      const status = document.createElement("small");
      status.className = "run-tab-status";
      status.textContent = tool.failed ? clipReason(tool.reason ?? "没做成") : "在读";
      const badge = document.createElement("i");
      badge.className = "run-tab-badge";
      row.append(glyph, status, badge);
    } else {
      const node = document.createElement("i");
      node.className = `run-graph-node ${tool.failed ? "dead" : "running"}`;
      const label = document.createElement("span");
      label.className = "run-graph-label";
      label.textContent = tool.failed ? `${tool.label} · ${clipReason(tool.reason ?? "没做成")}` : tool.label;
      row.append(node, label);
    }

    group.root.querySelector(group.kind === "b3" ? ".run-graph-fan" : ".run-graph-rows")!.append(row);
    group.rows.set(tool.id, row);
  };

  const paintEnd = (group: Group, tool: GraphTool): void => {
    const row = group.rows.get(tool.id);
    if (!row || row.classList.contains("run-graph-more")) return;
    row.dataset.state = tool.failed ? "dead" : "done";
    if (group.kind === "b3") {
      const status = row.querySelector(".run-tab-status");
      if (status) status.textContent = tool.failed ? clipReason(tool.reason ?? "没做成") : (tool.host ?? "读完");
    } else {
      const node = row.querySelector(".run-graph-node");
      node?.classList.remove("running");
      node?.classList.add(tool.failed ? "dead" : "done");
      const label = row.querySelector(".run-graph-label");
      if (label) label.textContent = tool.failed ? `${tool.label} · ${clipReason(tool.reason ?? "没做成")}` : (tool.result || tool.label);
    }
  };

  const closeIfIdle = (group: Group): void => {
    if (group.tools.some((tool) => tool.result === undefined && !tool.failed)) return;
    if (group.timer) return;
    group.root.dataset.mergedAt = String(Date.now());
    group.fold.textContent = `${groupSummary(group.kind, group.tools)} ›`;
    const skip = reducedMotion() || opts.history();
    if (skip) {
      group.root.dataset.state = "folded";
      group.fold.hidden = false;
      const rows = group.root.querySelector(".run-graph-rows, .run-graph-fan") as HTMLElement | null;
      if (rows) rows.hidden = true;
      if (current === group) current = null;
      pack();

      return;
    }

    group.root.dataset.state = "merging";
    group.timer = window.setTimeout(() => {
      group.root.dataset.state = "folding";
      group.timer = window.setTimeout(() => {
        group.root.dataset.state = "folded";
        group.fold.hidden = false;
        const rows = group.root.querySelector(".run-graph-rows, .run-graph-fan") as HTMLElement | null;
        if (rows) rows.hidden = true;
        group.timer = 0;
        if (current === group) current = null;
        pack();
      }, FOLD_MS);
    }, FOLD_HOLD_MS);
  };

  return {
    el,
    start(tool) {
      const next = { ...tool, host: tool.host ?? hostOfUrl(tool.url ?? tool.params.url) ?? undefined, url: tool.url ?? (typeof tool.params.url === "string" ? tool.params.url : undefined) };
      open.push(next);
      if (you) return;
      if (current && current.kind !== "you" && current.root.dataset.state === "live") {
        current.tools.push(next);
        addLane(current, next, current.tools.length - 1);
        current.root.dataset.lanes = String(current.tools.length);
        burst = [];

        return;
      }

      burst.push(next);
      window.clearTimeout(burstTimer);
      if (burst.length >= 2) {
        const kind = classifyKind(burst) ?? "b1";
        const group = startGroup(kind, [...burst]);
        group.root.dataset.lanes = String(group.tools.length);
        current = group;
        lastDead = null;
        burst = [];

        return;
      }

      burstTimer = window.setTimeout(() => {
        if (burst.length === 1 && lastDead) {
          const group = startGroup("b1", [lastDead, burst[0]!]);
          group.root.dataset.lanes = String(group.tools.length);
          current = group;
          lastDead = null;
        }

        burst = [];
      }, BURST_MS);
    },
    end(id, update) {
      const tool = open.find((item) => item.id === id);
      if (!tool) return;
      Object.assign(tool, update);
      if (update.failed) tool.failed = true;
      if (update.result !== undefined || update.failed) tool.result = update.result ?? tool.result ?? "";
      if (tool.failed) lastDead = tool;
      const group = groups.find((item) => item.tools.some((row) => row.id === id));
      if (!group) return;
      paintEnd(group, tool);
      closeIfIdle(group);
    },
    user(on) {
      if (on) {
        if (you) return;
        const tool: GraphTool = { id: "you", name: "hand_to_user", params: {}, label: "你" };
        you = startGroup("you", [tool]);
        current = you;

        return;
      }

      if (!you) return;
      const tool = you.tools[0]!;
      tool.result = "你交还了";
      paintEnd(you, tool);
      closeIfIdle(you);
      you = null;
    },
  };
}

function letterGlyph(host: string): HTMLElement {
  const glyph = document.createElement("span");
  glyph.className = "run-tab-glyph";
  glyph.textContent = host.charAt(0).toUpperCase() || "?";

  return glyph;
}
