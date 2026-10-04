// 前提：同一任务里，扩展能在博客页读、开新标签到维基读，再开新标签在笔记站写并提交一次。判据由练习站服务器独立给出：维基被读、笔记站恰好收到 1 次提交且内容一致；否则 exit 1。确认卡一律点允许，卡片内容核对属于正式验收。
import { createServer } from "node:http";
import { launchRealPath, requireHeadless, siteAddress, sleep, until } from "../acceptance/real-path/harness.mts";
import { configureViaSettings } from "../acceptance/real-path/inproc-config.mts";
import { startScriptedModel } from "../acceptance/real-path/scripted-model.mts";

requireHeadless();

const hits: string[] = [], notes: string[] = [], html = (b: string) => `<!doctype html><meta charset="utf-8"><title>t</title>${b}`;

const pages = new Map(Object.entries({
  "blog.test": html("<h1>Agents</h1><p>We introduce <b>Model Context Protocol</b>.</p>"),
  "wiki.test": html("<h1>Model Context Protocol</h1><p id=summary>MCP 是一种开放协议。</p>"),
  "flomo.test": html("<form method=post action=/memo><textarea name=content id=note></textarea><button>保存</button></form>"),
}));

const site = createServer((q, r) => {
  const host = String(q.headers.host).split(":")[0]!, body: string[] = [];
  hits.push(`${q.method} ${host}${q.url}`);

  if (q.method !== "POST") return r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(pages.get(host) ?? html("404"));
  q.on("data", c => body.push(String(c))).on("end", () => { notes.push(decodeURIComponent(body.join("").replace(/\+/g, " "))); r.end(html("ok")); });
}).listen(0, "127.0.0.1");

await new Promise(r => site.once("listening", r));

const model = await startScriptedModel([{ match: "跨站前提", steps: [
  { tool: { name: "tabs", args: { action: "open", url: "http://wiki.test/MCP" } } }, { tool: { name: "read_elements", args: { selector: "#summary" } } },
  { tool: { name: "tabs", args: { action: "open", url: "http://flomo.test/" } } }, { tool: { name: "fill", args: { target: "#note", value: "MCP 是一种开放协议。" } } },
  { tool: { name: "click", args: { target: "button", label: "保存" } } }, { text: "跨站完成。" }] }]);

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=${[...pages.keys()].map(h => `MAP ${h} 127.0.0.1:${siteAddress(site).port}`).join(", ")}`, "--no-proxy-server"] });

let ok = false;

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await rp.evaluate(panel, `document.querySelector('#send-btn')?.disabled===false`)) || undefined, 20000, "侧栏就绪");
  await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "k" } }, { baseUrl: model.baseUrl });
  const blog = await rp.cdp.send("Target.createTarget", { url: "http://blog.test/post" }); await rp.cdp.send("Target.activateTarget", { targetId: blog.targetId }); await sleep(800);
  await rp.click(panel, "#input"); await rp.typeText(panel, "跨站前提：查 Model Context Protocol 并记到笔记"); await rp.pressEnter(panel);
  await until(async () => {
    await rp.evaluate(panel, `document.querySelector("#consent-requests:not([hidden]) .consent-allow:not(:disabled)")?.click()`);

    return (await rp.evaluate(panel, `document.querySelector('#messages')?.innerText.includes('跨站完成')`)) || undefined;
  }, 90000, "任务结束", 500);
  ok = hits.includes("GET wiki.test/MCP") && notes.length === 1 && notes[0] === "content=MCP 是一种开放协议。";
} catch (e) { console.error(e); } finally { console.log(JSON.stringify({ ok, hits, notes })); await rp.close(); await rp.remove(); await model.close(); site.close(); }

process.exitCode = ok ? 0 : 1;
