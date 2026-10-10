// 前提：隔离无头 Chrome 里，扩展看到的窗口是「已聚焦」，所以旧的「每步切前台」在无头里真的会切（keep-foreground 用例才能被故意弄坏）；
// 扩展后台能读出每个窗口的活动标签；Page.bringToFront 能把用户的标签设成活动标签。
import { launchRealPath, until } from "../acceptance/real-path/harness.mts";

const rp = await launchRealPath();
let ok = false;

try {
  const sw = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "service worker")).targetId);
  await until(async () => await rp.evaluate(sw, "typeof chrome === 'object' && !!chrome.tabs").catch(() => false), 15_000, "service worker ready");
  const first = (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank")!;
  const second = (await rp.cdp.send("Target.createTarget", { url: "data:text/html,<title>B</title>" })).targetId;
  const read = () => rp.evaluate(sw, `Promise.all([chrome.windows.getAll(), chrome.tabs.query({active:true})]).then(([w,t]) => ({ windows: w.map(x => ({ id: x.id, focused: x.focused })), active: t.map(x => x.title || x.url) }))`);
  const afterCreate = await read();
  await rp.cdp.send("Page.bringToFront", {}, await rp.attach(first.targetId));
  const afterFront = await read();
  // 扩展自己切换活动标签（旧代码 activateTab 用的就是这个调用）。
  const viaExt = await rp.evaluate(sw, `chrome.tabs.query({}).then(ts => { const b = ts.find(t => !t.active); return chrome.tabs.update(b.id, {active:true}).then(() => chrome.tabs.query({active:true})).then(a => ({ all: ts.map(t => [t.id, t.title, t.url, t.active]), now: a.map(x => x.id), wanted: b.id })); })`);
  console.log(JSON.stringify({ afterCreate, afterFront, viaExt, second }, null, 1));
  ok = afterFront.windows.every((w: { focused: boolean }) => w.focused === true) && viaExt.now.includes(viaExt.wanted);
} finally {
  await rp.close(); await rp.remove();
}

console.log(ok ? "成立" : "不成立");
process.exit(ok ? 0 : 1);
