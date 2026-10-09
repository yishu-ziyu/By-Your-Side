// 前提：站点提示里的 Excalidraw 代码原样拼起来，在空白 excalidraw.com 上一次调用就画出「4 个带字方框 + 3 个绑定箭头」并整图进入视野，再一次调用把第二步改红。
// 运行：npx tsx scripts/probes/excalidraw-site-hint.mts（无头、需联网）。退出码 0 为成立。截图写到 out/acceptance/excalidraw-site-hint-*.png。
import { join } from "node:path";
import { siteHintFor } from "../../agent/src/site-hints.ts";
import { REPO, launchRealPath, sleep, until } from "../acceptance/real-path/harness.mts";

const lines = siteHintFor("https://excalidraw.com")!.text.split("\n"), line = (start: string) => lines.find(l => l.startsWith(start))!;
const API = line("API: ").slice(5), PASTE = line("const dt="), CHECK = line("const all="), EDIT = line("api.updateScene");
const els = ["输入账号", "输入密码", "点登录", "进入首页"].flatMap((text, i) => [
  { id: `b${i}`, type: "rectangle", x: i * 220, y: 0, width: 160, height: 70, boundElements: [{ type: "text", id: `t${i}` }, ...(i ? [{ type: "arrow", id: `a${i - 1}` }] : []), ...(i < 3 ? [{ type: "arrow", id: `a${i}` }] : [])] },
  { id: `t${i}`, type: "text", text, fontSize: 20, containerId: `b${i}`, textAlign: "center", verticalAlign: "middle" },
  ...(i < 3 ? [{ id: `a${i}`, type: "arrow", x: i * 220 + 160, y: 35, points: [[0, 0], [60, 0]], startBinding: { elementId: `b${i}` }, endBinding: { elementId: `b${i + 1}` }, endArrowhead: "arrow" }] : []),
]);
const rp = await launchRealPath();
let ok = false;
try {
  const work = await rp.attach((await until(async () => (await rp.targets()).find(t => t.url === "about:blank"), 10_000, "空白页")).targetId);
  await rp.cdp.send("Page.navigate", { url: "https://excalidraw.com" }, work);
  await until(async () => (await rp.evaluate(work, `!!document.querySelector(".excalidraw canvas")`).catch(() => false)) || undefined, 60_000, "画布");
  await sleep(2000);
  type Row = { type: string; label?: string; from?: string; to?: string; head?: string; stroke: string; bg: string };
  const drawn = await rp.evaluate(work, `(async()=>{${API}const els=${JSON.stringify(els)};${PASTE}${CHECK}})()`) as Row[];
  await sleep(1200);
  const view = await rp.evaluate(work, `(() => { ${API} const s = api.getAppState(); return api.getSceneElements().filter(e => e.type === "rectangle").every(e => (e.x + s.scrollX) * s.zoom.value >= 0 && (e.x + e.width + s.scrollX) * s.zoom.value <= s.width && (e.y + s.scrollY) * s.zoom.value >= 0 && (e.y + e.height + s.scrollY) * s.zoom.value <= s.height); })()`);
  await rp.screenshot(work, join(REPO, "out/acceptance/excalidraw-site-hint-draw.png"));
  const edited = await rp.evaluate(work, `(async()=>{${API}const boxId=api.getSceneElements().find(e=>e.type==="text"&&e.text.includes("输入密码"))?.containerId;${EDIT}${CHECK}})()`) as Row[];
  await sleep(1200);
  const saved = await rp.evaluate(work, `JSON.parse(localStorage.excalidraw).filter(e => !e.isDeleted && e.type === "rectangle" && e.strokeColor === "#e03131").length`);
  await rp.screenshot(work, join(REPO, "out/acceptance/excalidraw-site-hint-edit.png"));
  const boxes = drawn.filter(r => r.type === "rectangle").map(r => r.label).join(","), arrows = drawn.filter(r => r.type === "arrow" && r.head === "arrow").map(r => `${r.from}>${r.to}`).join(",");
  ok = boxes === "输入账号,输入密码,点登录,进入首页" && arrows === "输入账号>输入密码,输入密码>点登录,点登录>进入首页" && view === true
    && edited.filter(r => r.type === "rectangle" && r.stroke === "#e03131").map(r => r.label).join() === "输入密码" && saved === 1;
  console.log(JSON.stringify({ boxes, arrows, inView: view, redBoxes: edited.filter(r => r.stroke === "#e03131").map(r => r.label), savedRed: saved }));
} finally { await rp.close(); await rp.remove(); }
console.log(ok ? "成立" : "不成立");
process.exit(ok ? 0 : 1);
