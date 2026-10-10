/**
 * 前提：页面 elementFromPoint 命中的盖在按钮上的元素，能经扩展的 chrome.debugger（DOM.describeNode）换成节点编号，
 * 再用 Accessibility.getPartialAXTree 往上找到它的角色和名字（弹层「Cookie 设置」）。
 *   npx tsx scripts/probes/covered-by-name.mts
 */
import { createServer } from "node:http";
import { launchRealPath, siteAddress, until } from "../acceptance/real-path/harness.mts";

const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:40px"><button id="b">保存设置</button>
<div role="dialog" aria-label="Cookie 设置" style="position:fixed;inset:0;background:#0003"><p>我们使用 Cookie</p></div>`;
const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));
await new Promise<void>(d => site.listen(0, "127.0.0.1", d));
const url = `http://127.0.0.1:${siteAddress(site).port}/`;
const rp = await launchRealPath();
let ok = false;
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url }, work);
  const sw = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "sw")).targetId);
  await until(async () => await rp.evaluate(sw, "typeof chrome === 'object' && !!chrome.debugger").catch(() => false), 15_000, "扩展后台就绪");
  await until(async () => await rp.evaluate(sw, `chrome.tabs.query({ url: ${JSON.stringify(url)} }).then(([t]) => t?.status === "complete")`), 15_000, "页面加载");
  await rp.evaluate(sw, `globalThis.__probe = (async () => {
    const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(url)} });
    const t = { tabId: tab.id }, send = (m, p) => chrome.debugger.sendCommand(t, m, p);
    await chrome.debugger.attach(t, "1.3");
    const top = await send("Runtime.evaluate", { expression: "document.elementFromPoint(50, 50)" });
    const hit = (await send("DOM.describeNode", { objectId: top.result.objectId })).node;
    const { nodes } = await send("Accessibility.getPartialAXTree", { backendNodeId: hit.backendNodeId, fetchRelatives: true });
    const byId = new Map(nodes.map(n => [n.nodeId, n]));
    let n = nodes.find(a => a.backendDOMNodeId === hit.backendNodeId);
    while (n && n.role?.value !== "RootWebArea" && (n.ignored || !(n.name?.value || /dialog/.test(n.role?.value)))) n = byId.get(n.parentId);
    await chrome.debugger.detach(t);
    return { hit: hit.backendNodeId, named: n?.backendDOMNodeId, role: n?.role?.value, name: n?.name?.value };
  })().catch(e => ({ error: String(e) })); true`);
  const found = await until(async () => await rp.evaluate(sw, `globalThis.__probe.then(v => v)`, { timeoutMs: 3000 }).catch(() => null), 20_000, "读到挡住的元素");
  console.log(JSON.stringify(found));
  // SAFETY: evaluate 返回 JSON；只读这几个字段。
  const f = found as { role?: string; name?: string; named?: number };
  ok = f.role === "dialog" && f.name === "Cookie 设置" && typeof f.named === "number";
} finally { await rp.close(); await rp.remove(); site.close(); }
console.log(ok ? "成立" : "不成立");
process.exitCode = ok ? 0 : 1;
