import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, siteAddress, sleep, until, REPO } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const all = ["reply-empty-drift", "button-becomes-send"] as const;
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-send-confirm-reply-drift-${randomUUID().slice(0, 8)}`);
await mkdir(out, { recursive: true });
const posts: Array<{ body: string; kind: string; at: number }> = [];
const site = createServer(async (req, res) => {
  if (req.method === "POST") {
    let body = ""; req.setEncoding("utf8"); for await (const chunk of req) body += chunk;
    posts.push({ ...JSON.parse(body), at: Date.now() }); res.end("ok"); return;
  }
  const mode = req.url?.includes("mode=mutate") ? "mutate" : "reply";
  const initialLabel = mode === "mutate" ? "刷新预览" : "回复";
  res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<!doctype html><title>动态发送漂移测试</title><main><p>这是一段用于验证发送确认门禁的页面正文，请勿在未确认时直接提交。</p><form><textarea id="draft" aria-label="留言"></textarea><button id="action" type="submit">${initialLabel}</button></form></main><script>const f=document.querySelector('form'), d=document.querySelector('#draft'), b=document.querySelector('#action'); let armed=false; b.addEventListener('mousemove',()=>{ if(armed)return; armed=true; if(${JSON.stringify(mode)}==='reply'){ d.value='自动注入的敏感回复内容'; } else { d.value='自动注入的草稿'; b.textContent='发送'; } }); f.onsubmit=async e=>{ e.preventDefault(); await fetch('/send',{method:'POST',body:JSON.stringify({body:d.value,kind:b.textContent})}); };</script>`);
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const toolTexts: string[] = [];
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  ...all.map(name => ({ match: `漂移场景 ${name}`, steps: [{ tool: { name: "click", args: { target: "#action", label: name === "reply-empty-drift" ? "回复" : "刷新预览" } } }, { text: "操作结束。" }] })),
], undefined, payload => { for (const m of payload.messages ?? []) if (m.role === "tool") toolTexts.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content)); });
const rp = await launchRealPath();
const results: Array<{ name: string; pass: boolean; actual: unknown }> = [];
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(()=>true)`);
  const idle = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false';
  await until(() => rp.evaluate(panel, idle), 60_000, "侧栏就绪");
  for (const name of all) {
    const mode = name === "button-becomes-send" ? "mutate" : "reply";
    await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/?mode=${mode}` }, work);
    await until(() => rp.evaluate(work, '!!document.querySelector("#action")'), 10_000, "测试页就绪");
    await rp.click(panel, "#conversation-new"); await until(() => rp.evaluate(panel, idle), 10_000, "新对话就绪");
    const before = posts.length;
    const toolsBefore = toolTexts.length;
    await rp.click(panel, "#input"); await rp.typeText(panel, `漂移场景 ${name}`); await rp.pressEnter(panel);
    await until(() => rp.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].some(m=>m.textContent.includes("操作结束"))'), 30_000, `${name} 任务结束`);
    await sleep(1000);
    const sent = posts.length - before;
    const card = await rp.evaluate(panel, '!!document.querySelector(".send-confirm[data-state=open]")');
    const slice = toolTexts.slice(toolsBefore);
    const blocked = slice.some(t => t.includes("未点击") || t.includes("已变化") || t.includes("发送按钮"));
    const pass = sent === 0 && !card && blocked;
    results.push({ name, pass, actual: { sent, card, blocked, toolTexts: slice } });
    console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(results.at(-1)?.actual));
  }
} catch (error) { results.push({ name: "流程", pass: false, actual: String(error) }); console.error(String(error)); }
finally { await writeFile(join(out, "result.json"), JSON.stringify(results, null, 2)); await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(resolve => site.close(() => resolve())); }
console.log(`证据：${out}`);
if (results.length !== all.length || results.some(result => !result.pass)) process.exitCode = 1;
