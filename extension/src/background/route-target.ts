import type { ToolContract } from "../../../shared/protocol.js";
import { LEAD_SESSION_ID } from "../../../shared/protocol.js";
import { ROUTE_TEXT_ROLES, type RouteTarget } from "../../../shared/route.js";
import type { AxNodeLite } from "./axtree.js";
import { axBackendNodeFor } from "./axstate.js";
import { sendCommand } from "./debugger.js";
import { callDom, ensureDomOps } from "./exec/page-call.js";
import { resolveWorkingTab } from "./state.js";

const ROLES = new Set(["link", "button", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", ...ROUTE_TEXT_ROLES]);

const AREAS = new Set(["form", "dialog", "alertdialog", "region", "group", "row", "article", "listitem", "navigation", "main", "complementary", "banner", "contentinfo", "search"]);

const LABEL_ROLES = new Set(["StaticText", "heading", "link", "image"]);

const MAX = 40;

const clean = (text: string | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

function routeTargets(nodes: readonly AxNodeLite[]): Map<number, RouteTarget> {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));

  const up = (n: AxNodeLite) => {
    const out: AxNodeLite[] = [];

    for (let a = byId.get(n.parentId ?? ""); a && out.length < 64; a = byId.get(a.parentId ?? "")) out.push(a);

    return out;
  };

  const label = (n: AxNodeLite | undefined, own: string, depth = 0): string => {
    if (!n || depth > 8) return "";
    const text = LABEL_ROLES.has(n.role?.value ?? "") ? clean(n.name?.value) : "";

    if (text && text !== own) return text;

    for (const id of n.childIds ?? []) {
      const found = label(byId.get(id), own, depth + 1);

      if (found) return found;
    }

    return "";
  };

  const items: Array<{ node: AxNodeLite; target: RouteTarget; chain: AxNodeLite[] }> = [];

  for (const n of nodes) {
    const name = clean(n.name?.value);

    if (n.ignored || !n.backendDOMNodeId || !ROLES.has(n.role?.value ?? "") || !name) continue;
    const chain = up(n);
    const named = chain.find((a) => AREAS.has(a.role?.value ?? ""));
    const area = named ? `${named.role!.value}:${(clean(named.name?.value) || label(named, "")).slice(0, MAX)}` : "";
    items.push({ node: n, chain, target: { role: n.role!.value!, name: name.slice(0, 300), area, box: "" } });
  }

  const groups = new Map<string, typeof items>();

  for (const item of items) {
    const key = `${item.target.role}\n${item.target.name}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    for (const item of group) {
      const box = item.chain.find((a) => group.filter((other) => other.chain.includes(a) || other.node === a).length === 1);
      item.target.box = label(box, item.target.name).slice(0, MAX);
    }
  }

  return new Map(items.map((item) => [item.node.backendDOMNodeId!, item.target]));
}

type DomNode = { backendNodeId?: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[]; contentDocument?: DomNode };

async function backendOfSelector(tabId: number, target: string): Promise<number | undefined> {
  const mark = Math.random().toString(36).slice(2);
  await ensureDomOps(tabId);

  const marked = await callDom(tabId, (target: string, mark: string) => {
    const el = window.__sideagent?.dom?.resolve(target);
    el?.setAttribute("data-sideagent-route", mark);

    return !!el;
  }, [target, mark]);

  if (!marked) return undefined;

  try {
    const { root } = await sendCommand<{ root: DomNode }>(tabId, "DOM.getDocument", { depth: -1, pierce: true }, undefined, 5_000);

    const find = (n: DomNode): number | undefined => {
      const at = n.attributes?.indexOf("data-sideagent-route") ?? -1;

      if (at >= 0 && at % 2 === 0 && n.attributes![at + 1] === mark) return n.backendNodeId;

      for (const c of [...n.children ?? [], ...n.shadowRoots ?? [], ...(n.contentDocument ? [n.contentDocument] : [])]) {
        const found = find(c);

        if (found !== undefined) return found;
      }

      return undefined;
    };

    return find(root);
  } finally {
    await callDom(tabId, (target: string) => window.__sideagent?.dom?.resolve(target)?.removeAttribute("data-sideagent-route"), [target]).catch(() => undefined);
  }
}

export async function describeTarget(params: ToolContract["describe_target"]["params"], sessionId: string = LEAD_SESSION_ID): Promise<ToolContract["describe_target"]["data"]> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  const ref = /^@(\d+)$/.exec(params.target)?.[1];
  const backend = ref ? axBackendNodeFor(tab.id, Number(ref)) : params.target.startsWith("@") ? undefined : await backendOfSelector(tab.id, params.target).catch(() => undefined);

  if (backend === undefined) return { target: null };
  const { nodes = [] } = await sendCommand<{ nodes?: AxNodeLite[] }>(tab.id, "Accessibility.getFullAXTree", undefined, undefined, 5_000);

  return { target: routeTargets(nodes).get(backend) ?? null };
}
