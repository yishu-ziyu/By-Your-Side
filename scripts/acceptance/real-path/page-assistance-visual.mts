/**
 * 真扩展 + 隔离 Chrome + 本机脚本模型：点按钮后看小气泡，圈出段落后看细线轻标签。
 * 判定页面收到的点击、气泡几何、圈画相对目标的位置；不证明真实模型会选对目标。
 * npm run lab -- case page-assistance-visual
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-page-assistance-visual`);
await mkdir(out, { recursive: true });
const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>灯塔档案</title>
<style>body{margin:80px;font:17px/1.8 -apple-system,sans-serif;background:#fffffc;color:#30382c}article{max-width:600px}button{font:inherit;padding:7px 18px;margin:20px 0}</style>
<article><h1>灯塔档案</h1><p id="ink">紫色染料比普通黑墨更耐盐雾，能让航海记录保存几十年。</p><p>记录不仅是往事，也是下一次出航的依据。</p><button id="hours" onclick="this.dataset.clicks=String(+(this.dataset.clicks||0)+1)">营业时间</button></article>`));
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const goal = "点一次营业时间，然后圈出紫色染料这段";
const model = await startScriptedModel([{ match: goal, steps: [
  { tool: { name: "snapshot", args: {} } },
  { tool: { name: "click", args: { target: "#hours", label: "营业时间" } } },
  { tool: { name: "mark", args: { target: "#ink", label: "耐盐雾，保存更久" } }, delayMs: 3000 },
  { text: "已经圈出保存更久的原因。", delayMs: 2000 },
] }]);
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
type Node = { backendNodeId: number; attributes?: string[]; children?: Node[]; shadowRoots?: Node[] };
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false }, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(()=>true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60000, "侧栏就绪");
  const readOverlay = async <T,>(kind: string, fn: string): Promise<T | null> => {
    const doc = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: Node };
    const find = (n: Node): Node | undefined => {
      const at = n.attributes?.indexOf("data-sideagent-overlay") ?? -1;
      if (at >= 0 && n.attributes?.[at + 1] === kind) return n.shadowRoots?.[0];
      for (const child of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) { const hit = find(child); if (hit) return hit; }
    };
    const node = find(doc.root);
    if (!node) return null;
    const resolved = await rp.cdp.send("DOM.resolveNode", { backendNodeId: node.backendNodeId }, work);
    const result = await rp.cdp.send("Runtime.callFunctionOn", { objectId: resolved.object.objectId, functionDeclaration: fn, returnByValue: true }, work);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await rp.click(panel, "#input"); await rp.typeText(panel, goal); await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(work, 'document.querySelector("#hours").dataset.clicks==="1"'), 30000, "真实按钮被点一次");
  const bubble = await until(() => readOverlay<{height:number;width:number;font:number;radius:string;orb:boolean;text:string}>("cursor", `function(){const l=this.querySelector('.cursor.acting .label');if(!l)return null;const s=getComputedStyle(l),r=l.getBoundingClientRect();return {height:r.height,width:r.width,font:parseFloat(s.fontSize),radius:s.borderRadius,orb:!!l.querySelector('.orb-dot'),text:l.innerText}}`), 1500, "动作气泡");
  await rp.screenshot(work, join(out, "cursor.png"));
  check("小气泡保留原圆角，没有装饰光球", bubble.height <= 28 && bubble.width <= 200 && bubble.font === 12 && bubble.radius === "4px 12px 12px" && !bubble.orb && bubble.text.includes("营业时间"), bubble);
  const mark = await until(() => readOverlay<{stroke:number;background:string;shadow:string;label:string;left:number;right:number;top:number;bottom:number}>("marks", `function(){const m=this.querySelector('.mark'),p=m?.querySelector('path'),l=m?.querySelector('.mark-label');if(!p||!l)return null;const s=getComputedStyle(l),r=m.getBoundingClientRect();return {stroke:parseFloat(getComputedStyle(p).strokeWidth),background:s.backgroundColor,shadow:s.boxShadow,label:l.innerText,left:r.left,right:r.right,top:r.top,bottom:r.bottom}}`), 15000, "圈画出现");
  await sleep(500);
  await rp.screenshot(work, join(out, "marks.png"));
  const target = await rp.evaluate(work, '(()=>{const r=document.querySelector("#ink").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()') as {left:number;right:number;top:number;bottom:number};
  check("细圈和无底色标签仍圈住原段落", mark.stroke <= 1.4 && mark.background === "rgba(0, 0, 0, 0)" && mark.shadow === "none" && mark.label === "耐盐雾，保存更久" && mark.left <= target.left && mark.right >= target.right && mark.top <= target.top && mark.bottom >= target.bottom, {mark,target});
  await until(async () => await rp.evaluate(panel, 'document.body.innerText.includes("已经圈出保存更久的原因")'), 15000, "任务交付");
  check("只点了一次，圈画没有额外点击", await rp.evaluate(work, 'document.querySelector("#hours").dataset.clicks==="1"'), {});
} catch (err) { check("流程完成", false, String(err)); }
finally {
  await writeFile(join(out, "result.json"), JSON.stringify({status: checks.length && checks.every(c=>c.pass) ? "PASS" : "FAIL", checks}, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(()=>done()));
}
console.log(`证据：${out}`);
if (!checks.length || checks.some(c=>!c.pass)) process.exitCode = 1;
