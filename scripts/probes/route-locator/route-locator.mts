// 前提（YIS-94）：控件按无障碍树的「角色 + 名字 + 所在区域」记下，刷新后用同样的办法找回，不会找错；认不出就算「分不清」。
// npx tsx scripts/probes/route-locator/route-locator.mts   退出码 0 = 一次都没找错。CHROME 环境变量可指定 Chrome。
import { chromium, type CDPSession } from "playwright";

type Ax = { nodeId: string; parentId?: string; childIds?: string[]; ignored?: boolean; role?: { value: string }; name?: { value: string }; backendDOMNodeId?: number };

type Item = { role: string; name: string; area: string; box: string; sig: string; node: Ax };

const ROLES = new Set(["link", "button", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "slider", "spinbutton", "tab", "menuitem"]);

const AREAS = new Set(["form", "dialog", "region", "group", "row", "article", "listitem", "navigation", "main", "complementary", "banner", "contentinfo", "search"]);

const here = new URL(".", import.meta.url).href;

const pages = [`${here}booking-v1.html`, `${here}booking-v2.html`, "https://httpbin.org/forms/post", "https://books.toscrape.com/", "https://quotes.toscrape.com/login", "https://en.wikipedia.org/wiki/Special:Search", "https://github.com/trending"];

const SIG = "function(){ const p=[]; for(let e=this;e&&e.parentElement;e=e.parentElement) p.unshift([...e.parentElement.children].indexOf(e)); return p.join('.'); }";

async function controls(c: CDPSession): Promise<Item[]> {
  // SAFETY: CDP Accessibility.getFullAXTree 返回 { nodes }，字段见 Ax。
  const { nodes } = (await c.send("Accessibility.getFullAXTree")) as { nodes: Ax[] };
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));

  const up = (n: Ax) => { const r: Ax[] = [];

 for (let a = byId.get(n.parentId ?? ""); a; a = byId.get(a.parentId ?? "")) r.push(a);

 return r; };

  const label = (n: Ax | undefined, own: string, d = 0): string => {
    if (!n || d > 8) return "";
    const v = ["StaticText", "heading", "link", "image"].includes(n.role?.value ?? "") ? (n.name?.value ?? "").trim() : "";

    return v && v !== own ? v : (n.childIds ?? []).map((id) => label(byId.get(id), own, d + 1)).find(Boolean) ?? "";
  };

  const out: Item[] = [];

  for (const n of nodes) {
    if (n.ignored || !ROLES.has(n.role?.value ?? "") || !n.name?.value.trim() || !n.backendDOMNodeId) continue;
    const named = up(n).find((a) => AREAS.has(a.role?.value ?? ""));
    const area = named ? `${named.role!.value}:${(named.name?.value || label(named, "")).trim().slice(0, 40)}` : "";
    // SAFETY: CDP DOM.resolveNode 返回 { object: { objectId } }；Runtime.callFunctionOn 的 returnByValue 结果是字符串。
    const obj = (await c.send("DOM.resolveNode", { backendNodeId: n.backendDOMNodeId }).catch(() => null)) as { object?: { objectId: string } } | null;
    // SAFETY: 同上，returnByValue 的结果是上面 SIG 函数返回的字符串。
    const sig = obj?.object ? String(((await c.send("Runtime.callFunctionOn", { objectId: obj.object.objectId, functionDeclaration: SIG, returnByValue: true })) as { result: { value: string } }).result.value) : "?";
    out.push({ role: n.role!.value, name: n.name.value.trim(), area, box: "", sig, node: n });
  }

  // 重名时：往上找「只装着它一个同名控件」的最小容器，取容器里第一段不是它自己名字的文字。
  for (const o of out) {
    const group = out.filter((x) => x.role === o.role && x.name === o.name);

    if (group.length > 1) o.box = label(up(o.node).find((a) => group.filter((g) => up(g.node).includes(a)).length === 1), o.name).slice(0, 40);
  }

  return out;
}

const b = await chromium.launch({ executablePath: process.env.CHROME });

let wrong = 0;

for (const url of pages) {
  const p = await b.newPage();
  await p.goto(url, { waitUntil: "load", timeout: 30_000 }).catch(() => undefined);
  const c = await p.context().newCDPSession(p);
  const before = await controls(c);
  await p.reload({ waitUntil: "load" }).catch(() => undefined);
  const after = await controls(c);
  const t = { total: before.length, found: 0, ambiguous: 0, missing: 0, wrong: 0 };

  for (const r of before) {
    const same = after.filter((a) => a.role === r.role && a.name === r.name);
    const pick = same.length === 1 ? same : same.filter((a) => a.area === r.area && a.box === r.box);

    if (!same.length) t.missing++; else if (pick.length !== 1) t.ambiguous++; else if (pick[0]!.sig !== r.sig) t.wrong++; else t.found++;
  }

  wrong += t.wrong;
  console.log(url.replace(here, ""), JSON.stringify(t));
  await p.close();
}

await b.close();

process.exit(wrong ? 1 : 0);
