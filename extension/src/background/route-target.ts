import type { ToolContract } from "../../../shared/protocol.js";
import { LEAD_SESSION_ID } from "../../../shared/protocol.js";
import type { RouteTarget } from "../../../shared/route.js";
import type { AxNodeLite } from "./axtree.js";
import { addAxRefs, axBackendNodeFor } from "./axstate.js";
import { sendCommand } from "./debugger.js";
import { resolveWorkingTab } from "./state.js";

/**
 * 做法里怎么认一个控件（YIS-94）：无障碍树里的角色 + 名字 + 所在区域，与模型看到的同源。
 * 记下与找回用同一套算法；前提小实验 scripts/probes/route-locator/ 在 7 个页面上找错 0 次。
 * 产品原有的 loc=role: 自己算名字，和模型看到的不一致（预订页 11 个控件 6 个找不到），所以不用它。
 */
const ROLES = new Set(["link", "button", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem"]);

const AREAS = new Set(["form", "dialog", "alertdialog", "region", "group", "row", "article", "listitem", "navigation", "main", "complementary", "banner", "contentinfo", "search"]);

const LABEL_ROLES = new Set(["StaticText", "heading", "link", "image"]);

const MAX = 40;

const clean = (text: string | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/** 页面上每个可认的控件及其描述，按 backendDOMNodeId 索引。 */
export function routeTargets(nodes: readonly AxNodeLite[]): Map<number, RouteTarget> {
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

  // 同名控件：往上找「只装着它一个同名控件」的最小容器，取容器里第一段不是它自己名字的文字（如卡片标题「青松」）。
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

/** 读当前页的无障碍树，给一个 @N 控件写出描述；认不出（不在树里、没名字）返回 null。只读。 */
export async function describeTarget(params: ToolContract["describe_target"]["params"], sessionId: string = LEAD_SESSION_ID): Promise<ToolContract["describe_target"]["data"]> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  const ref = /^@(\d+)$/.exec(params.target)?.[1];
  const backend = ref ? axBackendNodeFor(tab.id, Number(ref)) : undefined;

  if (backend === undefined) return { target: null };
  const { nodes = [] } = await sendCommand<{ nodes?: AxNodeLite[] }>(tab.id, "Accessibility.getFullAXTree", undefined, undefined, 5_000);

  return { target: routeTargets(nodes).get(backend) ?? null };
}

/**
 * 照走（YIS-95）：在当前页找角色、名字、所在区域、所在卡片四项都相同的控件；恰好一个才登记成可执行的 @N（编号即 backendDOMNodeId），否则不给。只读。
 */
export async function findRouteTarget(params: ToolContract["find_route_target"]["params"], sessionId: string = LEAD_SESSION_ID): Promise<ToolContract["find_route_target"]["data"]> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  const want = params.target;

  if (!want) return { url: tab.url ?? "", ref: null, matches: 0 };
  const { nodes = [] } = await sendCommand<{ nodes?: AxNodeLite[] }>(tab.id, "Accessibility.getFullAXTree", undefined, undefined, 5_000);
  const hits = [...routeTargets(nodes)].filter(([, t]) => t.role === want.role && t.name === want.name && t.area === want.area && t.box === want.box);

  if (hits.length !== 1) return { url: tab.url ?? "", ref: null, matches: hits.length };
  addAxRefs(tab.id, [hits[0]![0]]);

  return { url: tab.url ?? "", ref: `@${hits[0]![0]}`, matches: 1 };
}
