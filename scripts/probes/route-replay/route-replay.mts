// 前提（YIS-95）：用记下做法的同一套算法（routeTargets）在刷新后的页面上逐步找回控件，换进这次的值（含「选哪间」这种卡片），能做对；页面改了就在那一步停下，不点错。
// npx tsx scripts/probes/route-replay/route-replay.mts   退出码 0 = 通过。CHROME 环境变量可指定 Chrome。
import { chromium, type CDPSession, type Page } from "playwright";

Object.assign(globalThis, { chrome: { tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } }, runtime: { onMessage: { addListener() {} } }, debugger: { onEvent: { addListener() {} }, onDetach: { addListener() {} } } } });

const { routeTargets } = await import("../../../extension/src/background/route-target.ts");

type T = { role: string; name: string; area: string; box: string };

const rooms = (btn: string, table: boolean) => ["青松", "白桦", "银杏"].map((n) => table ? `<tr><td>${n}</td><td><button type="button" onclick="room='${n}'">${btn}</button></td></tr>` : `<div><h3>${n}</h3><button type="button" onclick="room='${n}'">${btn}</button></div>`).join("");

const html = (changed: boolean) => `<!doctype html><meta charset="utf-8"><h1>会议室预订</h1><label>日期 <select id="date"><option value="">选择日期</option><option>10 月 9 日（周四）</option><option>10 月 16 日（周四）</option></select></label>
<label>时间 <select id="time"><option value="">选择时间</option><option>14:00–15:00</option><option>15:00–16:00</option></select></label>
<section aria-label="会议室">${changed ? `<table>${rooms("预约此间", true)}</table>` : rooms("选择", false)}</section><label>会议主题 <input id="topic"></label>
<button type="button" onclick="ok.textContent=[date.value,time.value,room,topic.value].join('|')">预订</button><output id="ok"></output><script>let room=''</script>`;

const ACT = "function(v){ if(this.tagName==='SELECT'){ this.value=[...this.options].find(o=>o.text===v).value; this.dispatchEvent(new Event('change',{bubbles:true})); } else if(this.tagName==='INPUT'){ this.value=v; this.dispatchEvent(new Event('input',{bubbles:true})); } else this.click(); }";

// SAFETY: getFullAXTree 返回 { nodes }，节点形状即 routeTargets 读的 AxNodeLite。
const tree = async (c: CDPSession) => routeTargets(((await c.send("Accessibility.getFullAXTree")) as { nodes: never[] }).nodes);

const act = async (c: CDPSession, backendNodeId: number, value?: string) => {
  // SAFETY: CDP DOM.resolveNode 返回 { object: { objectId } }。
  const { object } = (await c.send("DOM.resolveNode", { backendNodeId })) as { object: { objectId: string } };
  await c.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: ACT, arguments: [{ value }] });
};

const open = async (changed: boolean) => { p = await b.newPage(); await p.setContent(html(changed)); const c = await p.context().newCDPSession(p); await c.send("DOM.enable");

 return c; };

const b = await chromium.launch({ executablePath: process.env.CHROME });

let p: Page;

// 第一次：每步动手前记下控件描述（与 describe_target 一样）。
const first: Array<[selector: string, value?: string]> = [["#date", "10 月 9 日（周四）"], ["#time", "15:00–16:00"], ["div:nth-of-type(1) > button"], ["#topic", "周会"], ["预订"]];

let c = await open(false);

const route: Array<{ target: T; value?: string }> = [];

for (const [sel, value] of first) {
  // SAFETY: Runtime.evaluate 返回 result.objectId；DOM.describeNode 返回 node.backendNodeId。
  const { result } = (await c.send("Runtime.evaluate", { expression: `[...document.querySelectorAll("button")].find(b=>b.textContent==="预订"&&${JSON.stringify(sel)}==="预订") ?? document.querySelector(${JSON.stringify(sel)})` })) as { result: { objectId: string } };
  // SAFETY: 同上。
  const id = ((await c.send("DOM.describeNode", { objectId: result.objectId })) as { node: { backendNodeId: number } }).node.backendNodeId;
  route.push({ target: (await tree(c)).get(id)!, value });
  await act(c, id, value);
}

console.log("记下:", JSON.stringify(route.map((s) => [s.target.role, s.target.name, s.target.area, s.target.box])), await p.textContent("#ok"));

// 第二次：换值（日期、时间、主题、选哪间），逐步严格找回（四项都相同、唯一），找不到/不唯一就停。
const swap = new Map(Object.entries({ "10 月 9 日（周四）": "10 月 16 日（周四）", "15:00–16:00": "14:00–15:00", 周会: "复盘", 青松: "白桦" }));

const replay = async (changed: boolean) => {
  c = await open(changed);

  for (const [i, s] of route.entries()) {
    const want = { ...s.target, box: swap.get(s.target.box) ?? s.target.box };
    const hits = [...(await tree(c))].filter(([, t]) => t.role === want.role && t.name === want.name && t.area === want.area && t.box === want.box);

    if (hits.length !== 1) return `第 ${i + 1} 步停下（${hits.length ? "分不清" : "找不到"}「${want.name}」），页面：${await p.textContent("#ok")}|room=${await p.evaluate("room")}`;
    await act(c, hits[0]![0], s.value === undefined ? undefined : swap.get(s.value) ?? s.value);
  }

  return `做完：${await p.textContent("#ok")}`;
};

const same = await replay(false), changed = await replay(true);

console.log("照走:", same, "\n页面改了:", changed);

await b.close();

process.exit(same === "做完：10 月 16 日（周四）|14:00–15:00|白桦|复盘" && changed.startsWith("第 3 步停下") && changed.endsWith("room=") ? 0 : 1);
