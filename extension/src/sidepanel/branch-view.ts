/**
 * 过程块进行中的分叉层：挂在 summary 下面，不改 A+C 两行。
 * 几何与画法从认可的分支原型（git graph / 标签页扇形）直接移植：主轨、曲线分叉、
 * 虚线死路、空心汇合点、交给你时的蓝色通道。单步回合这里是空的。
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
  ROW_PX,
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
  /** 这一轮收尾：还开着的分支按结束画，并收成一行，不留在转的节点。 */
  finish: () => void;
};

const NS = "http://www.w3.org/2000/svg";
const MX = 8;
const LW = 11;
const BURST_MS = 280;

type Group = {
  root: HTMLElement;
  kind: GraphKind;
  tools: GraphTool[];
  rows: Map<string, HTMLElement>;
  fold: HTMLElement;
  body: HTMLElement;
  mergeEl: HTMLElement;
  rail: SVGSVGElement;
  timer: number;
  drawn: Set<string>;
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
  let paintQueued = 0;
  const pending = new Set<Group>();

  const show = () => {
    el.hidden = groups.length === 0;
    el.style.maxHeight = `${PROCESS_MAX_PX}px`;
  };

  const queuePaint = (group: Group) => {
    pending.add(group);
    if (paintQueued) return;
    paintQueued = requestAnimationFrame(() => {
      paintQueued = 0;
      const todo = [...pending];
      pending.clear();
      for (const item of todo) {
        paintRails(item);
        if (item.root.offsetHeight < 8 || item.root.clientWidth < 40) requestAnimationFrame(() => paintRails(item));
      }
    });
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
    root.style.setProperty("--fork-ms", `${FORK_MS}ms`);
    root.style.setProperty("--merge-ms", `${MERGE_MS}ms`);
    const rail = document.createElementNS(NS, "svg");
    rail.classList.add("run-graph-svg");
    rail.setAttribute("aria-hidden", "true");
    const body = document.createElement("div");
    body.className = kind === "b3" ? "run-graph-fan" : "run-graph-rows";
    const mergeEl = document.createElement("div");
    mergeEl.className = "run-graph-join";
    mergeEl.hidden = true;
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
      body.hidden = !openFold;
      mergeEl.hidden = !openFold;
      queuePaint(group);
    });
    root.append(rail, body, mergeEl, fold);
    const group: Group = { root, kind, tools, rows: new Map(), fold, body, mergeEl, rail, timer: 0, drawn: new Set() };
    for (const tool of tools) addLane(group, tool, group.tools.indexOf(tool));
    for (const other of groups) {
      if (other.root.dataset.state === "live" || other.root.dataset.state === "merging") {
        other.root.dataset.state = "folded";
        if (!other.fold.textContent) other.fold.textContent = `${groupSummary(other.kind, other.tools)} ›`;
        other.fold.hidden = false;
        other.body.hidden = true;
        other.mergeEl.hidden = true;
        window.clearTimeout(other.timer);
        other.timer = 0;
      }
    }

    current = group;
    groups.push(group);
    el.append(root);
    pack();
    show();
    queuePaint(group);

    return group;
  };

  const pack = () => {
    const busy = groups.some((g) => g.root.dataset.state === "live" || g.root.dataset.state === "merging" || g.root.dataset.state === "folding");
    for (const g of groups) g.root.hidden = busy && g.root.dataset.state === "folded";
  };

  const addLane = (group: Group, tool: GraphTool, index: number): void => {
    const cap = group.kind === "b3" ? MAX_TABS : MAX_LANES;
    const shown = index < cap;
    const extra = index - cap + 1;
    if (!shown && extra > 1) {
      const more = group.root.querySelector(".run-graph-more");
      if (more) more.textContent = `+${extra}`;

      return;
    }

    const row = document.createElement(group.kind === "b3" ? "span" : "div");
    row.className = group.kind === "b3" ? "run-tab-tile" : "run-graph-row";
    row.dataset.id = tool.id;
    row.dataset.state = tool.failed ? "dead" : "running";
    if (tool.user || tool.id === "you") row.dataset.user = "1";
    row.style.setProperty("--i", String(index));
    row.style.setProperty("--lanes", String(Math.min(group.tools.length, cap)));
    row.style.animationDelay = reducedMotion() ? "" : `${index * FORK_STAGGER_MS}ms`;
    if (!shown) {
      row.className = "run-graph-more";
      row.textContent = `+${extra}`;
      group.body.append(row);
      group.rows.set(tool.id, row);

      return;
    }

    if (group.kind === "b3") {
      const host = tool.user ? "你" : (tool.host ?? "页");
      const glyph = tool.user ? youGlyph() : tool.url ? siteGlyph(tool.url, host) : letterGlyph(host);
      glyph.classList.add("run-tab-glyph");
      const status = document.createElement("small");
      status.className = "run-tab-status";
      status.textContent = tool.failed ? clipReason(tool.reason ?? "没做成") : tool.user ? "交给你" : "在读";
      const badge = document.createElement("i");
      badge.className = "run-tab-badge";
      row.append(glyph, status, badge);
    } else {
      if (tool.host && !tool.user) {
        const fav = tool.url ? siteGlyph(tool.url, tool.host) : letterGlyph(tool.host);
        fav.classList.add("run-graph-fav");
        row.append(fav);
      }
      const label = document.createElement("span");
      label.className = "run-graph-label";
      setText(label, laneText(tool, "running"));
      row.append(label);
    }

    group.body.append(row);
    group.rows.set(tool.id, row);
    group.root.dataset.lanes = String(group.tools.length);
    for (const other of group.rows.values()) other.style.setProperty("--lanes", String(Math.min(group.tools.length, cap)));
    queuePaint(group);
  };

  const paintEnd = (group: Group, tool: GraphTool): void => {
    const row = group.rows.get(tool.id);
    if (!row || row.classList.contains("run-graph-more")) return;
    row.dataset.state = tool.failed ? "dead" : "done";
    if (group.kind === "b3") {
      const status = row.querySelector(".run-tab-status");
      if (status) setText(status, tool.failed ? clipReason(tool.reason ?? "没做成") : tool.user ? "你交还了" : (tool.host ?? "读完"));
    } else {
      const label = row.querySelector(".run-graph-label");
      if (label) setText(label, laneText(tool, tool.failed ? "dead" : "done"));
    }
    queuePaint(group);
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
      group.body.hidden = true;
      group.mergeEl.hidden = true;
      if (current === group) current = null;
      if (you === group) you = null;
      pack();

      return;
    }

    group.mergeEl.hidden = false;
    group.root.dataset.state = "merging";
    queuePaint(group);
    group.timer = window.setTimeout(() => {
      group.root.dataset.state = "folding";
      group.timer = window.setTimeout(() => {
        group.root.dataset.state = "folded";
        group.fold.hidden = false;
        group.body.hidden = true;
        group.mergeEl.hidden = true;
        group.timer = 0;
        if (current === group) current = null;
        if (you === group) you = null;
        pack();
      }, FOLD_MS);
    }, FOLD_HOLD_MS);
  };

  const attachYou = (): Group => {
    const tool: GraphTool = { id: "you", name: "hand_to_user", params: {}, label: "你", user: true };
    if (current && current.root.dataset.state === "live" && current.kind !== "b3") {
      current.tools.push(tool);
      addLane(current, tool, current.tools.length - 1);

      return current;
    }

    return startGroup("you", lastDead && lastDead.id !== "you" ? [{ ...lastDead }, tool] : [tool]);
  };

  return {
    el,
    start(tool) {
      const next = {
        ...tool,
        host: tool.host ?? hostOfUrl(tool.url ?? tool.params.url) ?? undefined,
        url: tool.url ?? (typeof tool.params.url === "string" ? tool.params.url : undefined),
      };
      open.push(next);
      if (you && you.root.dataset.state === "live") return;
      if (current && current.kind !== "you" && current.root.dataset.state === "live") {
        current.tools.push(next);
        addLane(current, next, current.tools.length - 1);
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
      // 已经结束的一步不再和下一步凑成「同时」：只有同时在跑的才画分叉（历史回放也是先开始、后结束、再开始下一步）。
      burst = burst.filter((item) => item.id !== id);
      Object.assign(tool, update);
      if (update.failed) tool.failed = true;
      if (update.result !== undefined || update.failed) tool.result = update.result ?? tool.result ?? "";
      if (tool.failed) lastDead = tool;
      const group = groups.find((item) => item.tools.some((row) => row.id === id));
      if (!group) return;
      paintEnd(group, tool);
      closeIfIdle(group);
    },
    finish() {
      window.clearTimeout(burstTimer);
      burst = [];

      for (const group of groups) {
        for (const tool of group.tools) {
          if (tool.result !== undefined || tool.failed) continue;
          tool.result = tool.id === "you" || tool.user ? "你交还了" : "";
          paintEnd(group, tool);
        }
        closeIfIdle(group);
      }
      you = null;
    },
    user(on) {
      if (on) {
        if (you && you.root.dataset.state === "live") return;
        you = attachYou();
        current = you;

        return;
      }

      if (!you) return;
      const tool = you.tools.find((item) => item.id === "you" || item.user);
      if (tool) {
        tool.result = "你交还了";
        paintEnd(you, tool);
      }
      closeIfIdle(you);
      if (you.root.dataset.state !== "live") you = null;
    },
  };
}

function laneText(tool: GraphTool, state: "running" | "done" | "dead"): string {
  if (tool.user || tool.id === "you") return state === "running" ? "交给你" : "你交还了";
  if (state === "dead") return `${tool.label} · ${clipReason(tool.reason ?? "没做成")}`;
  if (state === "done") return tool.result || tool.label;

  return tool.label;
}

function setText(el: Element, text: string): void {
  const host = el as HTMLElement;
  if ((host.dataset.text ?? host.textContent) === text) return;
  host.dataset.text = text;
  if (reducedMotion() || !host.textContent) {
    host.textContent = text;

    return;
  }

  const next = document.createElement("span");
  next.className = "run-graph-flip";
  next.textContent = text;
  host.replaceChildren(next);
}

function letterGlyph(host: string): HTMLElement {
  const glyph = document.createElement("span");
  glyph.className = "run-tab-glyph";
  glyph.textContent = host.charAt(0).toUpperCase() || "?";

  return glyph;
}

function youGlyph(): HTMLElement {
  const glyph = document.createElement("span");
  glyph.className = "run-tab-glyph run-tab-glyph-you";
  glyph.textContent = "你";

  return glyph;
}

function svgEl(name: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);

  return node;
}

function paintRails(group: Group): void {
  const { root, rail, kind, tools, rows, mergeEl, drawn } = group;
  const cap = kind === "b3" ? MAX_TABS : MAX_LANES;
  const lanes = tools.slice(0, cap).filter((tool) => rows.has(tool.id) && !rows.get(tool.id)!.classList.contains("run-graph-more"));
  const height = Math.max(root.offsetHeight, ROW_PX);
  const width = Math.max(root.clientWidth, 1);
  rail.setAttribute("width", String(width));
  rail.setAttribute("height", String(height));
  rail.removeAttribute("viewBox");
  if (!lanes.length) {
    rail.replaceChildren();

    return;
  }

  const keep = new Set<string>();
  const put = (key: string, node: SVGElement, grow: boolean) => {
    keep.add(key);
    node.setAttribute("data-k", key);
    if (grow) node.setAttribute("pathLength", "1");
    const prev = rail.querySelector(`[data-k="${CSS.escape(key)}"]`);
    if (prev) {
      prev.replaceWith(node);
      if (!grow || drawn.has(key) || reducedMotion()) node.classList.remove("run-graph-grow");
    } else {
      rail.append(node);
      if (grow && !reducedMotion()) node.classList.add("run-graph-grow");
    }
    drawn.add(key);
  };

  const cyOf = (tool: GraphTool): number | null => {
    const row = rows.get(tool.id);
    if (!row || row.hidden) return null;

    return row.offsetTop + row.offsetHeight / 2;
  };

  const first = lanes.map(cyOf).find((y) => y != null);
  const lastLane = [...lanes].reverse().map(cyOf).find((y) => y != null);
  const merging = root.dataset.state === "merging" || root.dataset.state === "folding";
  const joinY = !mergeEl.hidden ? mergeEl.offsetTop + mergeEl.offsetHeight / 2 : lastLane;
  const yF = first ?? 11;
  const yEnd = joinY ?? lastLane ?? yF;
  const mainColor = "var(--content-border-strong, rgba(20,20,19,.16))";

  put("main", svgEl("path", {
    d: `M${MX} ${yF} L${MX} ${yEnd}`,
    fill: "none",
    stroke: mainColor,
    "stroke-width": "1.2",
    ...(merging || lanes.some((tool) => !tool.failed && tool.result === undefined) ? { "stroke-dasharray": "2 3" } : {}),
  }), false);

  if (kind === "b3") {
    paintFan(group, lanes, yF, yEnd, merging, put);
  } else {
    paintGit(group, lanes, yF, yEnd, merging, put);
  }

  for (const node of [...rail.querySelectorAll("[data-k]")]) {
    const key = node.getAttribute("data-k");
    if (key && !keep.has(key)) node.remove();
  }
}

function paintGit(
  group: Group,
  lanes: GraphTool[],
  yF: number,
  yEnd: number,
  merging: boolean,
  put: (key: string, node: SVGElement, grow: boolean) => void,
): void {
  lanes.forEach((tool, index) => {
    const row = group.rows.get(tool.id);
    if (!row) return;
    const yb = row.offsetTop + row.offsetHeight / 2;
    const lx = MX + LW * (index + 1);
    const user = !!(tool.user || tool.id === "you");
    const col = user ? "var(--apple-blue)" : tool.failed ? "var(--text-quaternary)" : "var(--text-tertiary)";
    const live = row.dataset.state === "running";
    put(`fork-${tool.id}`, svgEl("path", {
      d: `M${MX} ${yF} C${MX} ${yF + 9} ${lx} ${yF + 5} ${lx} ${yF + 15} L${lx} ${yb}`,
      fill: "none",
      stroke: col,
      "stroke-width": "1.2",
      ...(tool.failed ? { "stroke-dasharray": "2 2" } : {}),
    }), true);
    if (!tool.failed) {
      const down = merging ? Math.max(yb, yEnd - 15) : yb;
      put(`down-${tool.id}`, svgEl("path", {
        d: `M${lx} ${yb} L${lx} ${down}`,
        fill: "none",
        stroke: col,
        "stroke-width": "1.2",
      }), false);
      if (merging) {
        put(`merge-${tool.id}`, svgEl("path", {
          d: `M${lx} ${yEnd - 15} C${lx} ${yEnd - 5} ${MX} ${yEnd - 9} ${MX} ${yEnd}`,
          fill: "none",
          stroke: col,
          "stroke-width": "1.2",
        }), true);
      }
    }
    put(`node-${tool.id}`, gitNode(lx, yb, live, tool.failed === true, user), false);
  });
  if (merging) put("ring", hollow(MX, yEnd), true);
}

function paintFan(
  group: Group,
  lanes: GraphTool[],
  yF: number,
  yEnd: number,
  merging: boolean,
  put: (key: string, node: SVGElement, grow: boolean) => void,
): void {
  lanes.forEach((tool) => {
    const row = group.rows.get(tool.id);
    if (!row) return;
    const x = row.offsetLeft + row.offsetWidth / 2;
    const top = row.offsetTop;
    const user = !!(tool.user || tool.id === "you");
    const col = user ? "var(--apple-blue)" : tool.failed ? "rgba(20,20,19,.2)" : "var(--text-quaternary)";
    put(`fork-${tool.id}`, svgEl("path", {
      d: `M${MX} ${yF} L${MX} ${top - 14} C${MX} ${top - 6} ${x} ${top - 12} ${x} ${top}`,
      fill: "none",
      stroke: col,
      "stroke-width": "1.2",
      ...(tool.failed ? { "stroke-dasharray": "2 2" } : {}),
    }), true);
    if (!tool.failed && merging) {
      const bottom = row.offsetTop + row.offsetHeight;
      put(`merge-${tool.id}`, svgEl("path", {
        d: `M${x} ${bottom} C${x} ${yEnd - 2} ${MX} ${yEnd - 12} ${MX} ${yEnd}`,
        fill: "none",
        stroke: col,
        "stroke-width": "1.2",
      }), true);
    }
  });
  if (merging) put("ring", hollow(MX, yEnd), true);
}

function gitNode(x: number, y: number, live: boolean, failed: boolean, user: boolean): SVGElement {
  if (live) {
    const g = svgEl("g", { transform: `translate(${x} ${y})`, color: user ? "var(--apple-blue)" : "var(--text-secondary)" });
    const spin = svgEl("g", { class: "run-graph-spin" });
    spin.append(
      svgEl("circle", { r: "4.6", fill: "var(--wallpaper)", stroke: "currentColor", "stroke-opacity": ".2", "stroke-width": "1.3" }),
      svgEl("path", { d: "M0 -4.6 A4.6 4.6 0 0 1 4.6 0", fill: "none", stroke: "currentColor", "stroke-width": "1.3", "stroke-linecap": "round" }),
    );
    g.append(spin);

    return g;
  }

  if (failed) {
    const g = svgEl("g", { transform: `translate(${x} ${y})`, class: "run-graph-x", stroke: "var(--text-quaternary)", "stroke-width": "1.3", "stroke-linecap": "round" });
    g.append(svgEl("path", { d: "M-3 -3 L3 3" }), svgEl("path", { d: "M3 -3 L-3 3" }));

    return g;
  }

  if (user) return svgEl("circle", { cx: String(x), cy: String(y), r: "3.4", fill: "var(--apple-blue)" });

  return svgEl("circle", { cx: String(x), cy: String(y), r: "3", fill: "var(--text-tertiary)" });
}

function hollow(x: number, y: number): SVGElement {
  const place = svgEl("g", { transform: `translate(${x} ${y})` });
  const pop = svgEl("g", { class: "run-graph-ring" });
  pop.append(svgEl("circle", {
    r: "3.6",
    fill: "var(--wallpaper)",
    stroke: "var(--text-tertiary)",
    "stroke-width": "1.3",
  }));
  place.append(pop);

  return place;
}
