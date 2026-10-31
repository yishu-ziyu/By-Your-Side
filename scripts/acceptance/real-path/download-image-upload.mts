/** PNG download → upload regression: real extension, Chrome downloads and receiving HTTP server.
 * Scripted model fixes tool order; --live uses the configured ChatGPT plan with user authorization.
 * npx tsx scripts/acceptance/real-path/download-image-upload.mts --headless [--live --thinking=medium]
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";
import { loadModelPlan, modelStorageItems } from "./inproc-config.mts";

const headed = process.argv.includes("--headed");
if (!headed) requireHeadless();
const live = process.argv.includes("--live");
const thinking = process.argv.includes("--thinking=medium") ? "medium" : undefined;
const ASK = "将资料表中的六件商品所有字段和主图填入下面的商品表单：前三张用直接链接下载，后三张点击下载链接取得，然后上传对应的原图，最后点保存商品。";
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-download-image-upload`);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=", "base64");
const names = ["高强度螺栓", "不锈钢管", "金属齿轮", "电动马达", "钢制梁", "电商项目软件"];
const categories = ["五金配件", "金属材料", "五金配件", "机电设备", "金属材料", "软件服务"];
const prices = ["8.00", "80.00", "36.50", "268.00", "320.00", "599.00"];
const stocks = ["1000", "500", "240", "65", "80", "30"];
const descriptions = ["用于连接结构件", "用于输送流体", "适用于机械传动", "用于小型设备驱动", "用于结构支撑", "用于商品及订单管理"];
const units = ["盒", "根", "件", "台", "根", "套"];
const fields = { name: "商品名称", sku: "商品编码", category: "类目", price: "价格", stock: "库存", description: "描述", unit: "单位", delivery: "配送方式" };
const goods = names.map((name, i) => ({ name, category: categories[i]!, price: prices[i]!, stock: stocks[i]!, description: descriptions[i]!, unit: units[i]!, delivery: "物流配送", sku: `SZ00${i + 1}`, image: Buffer.concat([png, Buffer.from(`product-${i + 1}`)]) }));
const values = (g: typeof goods[number]) => Object.fromEntries(Object.keys(fields).map(key => [key, g[key as keyof typeof fields]]));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const requests: string[] = [];
const received: Array<{ sku: string; name: string; filename: string; sha256: string; fields: Record<string, string> }> = [];
const site = createServer(async (req, res) => {
  const path = req.url ?? "";
  requests.push(`${req.method} ${path}`);
  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>六商品图片上传</title><h1>商品资料</h1><table>${goods.map(g => `<tr>${Object.entries(values(g)).map(([key, value]) => `<td>${fields[key as keyof typeof fields]}：${value}</td>`).join("")}<td><a id="download-${g.sku}" href="/images/${g.sku}.png" download="${g.sku}.png">下载 ${g.sku}.png</a></td></tr>`).join("")}</table><form id="goods">${goods.map(g => `<fieldset><legend>${g.sku}</legend>${Object.entries(fields).map(([key, label]) => `<label>${label}<input id="${key}-${g.sku}" required></label>`).join("")}<label>主图<input id="image-${g.sku}" type="file" accept="image/png" required></label></fieldset>`).join("")}<button id="save">保存商品</button></form><output id="receipt">尚未保存</output><script>
    document.querySelector('#goods').onsubmit=async event=>{event.preventDefault();const results=[];for(const sku of ${JSON.stringify(goods.map(g => g.sku))}){const file=document.querySelector('#image-'+sku).files[0];const response=await fetch('/receive/'+sku,{method:'POST',headers:{'x-filename':file.name,'x-name':encodeURIComponent(document.querySelector('#name-'+sku).value),'x-sku':document.querySelector('#sku-'+sku).value,'x-fields':encodeURIComponent(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(fields))}.map(key=>[key,document.querySelector('#'+key+'-'+sku).value]))))},body:file});results.push(await response.text());}document.querySelector('#receipt').textContent=results.join('\\n');};</script>`);
    return;
  }
  const product = goods.find(g => path === `/images/${g.sku}.png` || path === `/receive/${g.sku}`);
  if (product && req.method === "GET") {
    res.writeHead(200, { "content-type": "image/png", "content-length": product.image.length });
    res.end(product.image);
    return;
  }
  if (product && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const entry = { fields: JSON.parse(decodeURIComponent(String(req.headers["x-fields"]))) as Record<string, string>, sku: String(req.headers["x-sku"]), name: decodeURIComponent(String(req.headers["x-name"])), filename: String(req.headers["x-filename"]), sha256: hash(Buffer.concat(chunks)) };
    received.push(entry);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(`已收到 ${entry.filename} SHA-256 ${entry.sha256}`);
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
await mkdir(out, { recursive: true });
const steps: Rule["steps"] = [{ tool: { name: "browser_run", args: { code: 'return await browser.waitEvent({token:{token:"forged-event-token-779"}});' } } }];
for (const [i, g] of goods.entries()) {
  steps.push(i < 3
    ? { tool: { name: "download_url", args: { url: `${origin}/images/${g.sku}.png`, ...(i === 0 ? { filename: `${g.sku}.png` } : {}) } } }
    : { tool: { name: "browser_run", args: { code: `const arm=await browser.armEvent({type:"download"}); await browser.click({target:"#download-${g.sku}"}); return await browser.waitEvent({token:${i === 4 ? "arm" : "arm.token"},timeoutMs:30000});` } } });
}
for (const [index, g] of goods.entries()) {
  for (const [key, value] of Object.entries(values(g))) steps.push({ tool: { name: "fill", args: { target: `#${key}-${g.sku}`, value } } });
  steps.push(index < 3
    ? { tool: { name: "upload_file", args: { files: [`${g.sku}.png`], target: `#image-${g.sku}` } } }
    : { tool: { name: "browser_run", args: { code: `return await browser.uploadFile({files:["${g.sku}.png"],target:"#image-${g.sku}"});` } } });
}
steps.push({ tool: { name: "click", args: { target: "#save" } } }, { text: "六件商品已保存。" });
let leakedBase64 = false;
const toolResults = new Set<string>();
const model = await startScriptedModel([{ match: ASK, steps }], undefined, payload => {
  for (const message of payload.messages ?? []) {
    if (message.role === "tool") {
      const result = JSON.stringify(message.content);
      toolResults.add(result);
      if (/dataBase64|capturedFile/.test(result)) leakedBase64 = true;
    }
  }
});
const rp = await launchRealPath({ headed });
const progress = setInterval(() => console.log(`进度：图片请求 ${requests.filter(path => path.startsWith("GET /images/")).length}/6，接收商品 ${received.length}/6`), 15_000);
let panelId: string | undefined;
let workId: string | undefined;
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "工作页");
  const work = await rp.attach(blank.targetId);
  workId = work;
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  panelId = panel;
  const items = live ? modelStorageItems(await loadModelPlan("openai-codex/gpt-6-luna"))
    : { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  if (live) items.inproc_fast_model_config = items.inproc_model_config;
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  if (live && thinking) {
    await rp.evaluate(panel, `localStorage.setItem('sideagent.thinkingLevels',${JSON.stringify(JSON.stringify({"openai-codex/gpt-6-luna": "medium"}))})`);
    await rp.cdp.send("Page.reload", {}, panel);
  }
  const ready = 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });
  await rp.click(panel, "#input"); await rp.typeText(panel, ASK); await rp.pressEnter(panel);
  await until(async () => live
    ? received.length === 6 || await rp.evaluate(panel, `${ready} && document.querySelectorAll('.msg.assistant').length > 0`)
    : model.requests.some(r => r.rule === ASK && r.step === steps.length - 1 && r.finished), live ? 600_000 : 120_000, "六商品任务执行完毕", 1000);
  await until(async () => await rp.evaluate(panel, ready), 60_000, "任务结束");
  const downloadedNames = await readdir(rp.dirs.downloads);
  for (const [i, g] of goods.entries()) {
    const filename = `${g.sku}.png`;
    const saved = downloadedNames.includes(filename) ? await readFile(join(rp.dirs.downloads, filename)) : Buffer.alloc(0);
    const target = received.find(row => row.sku === g.sku);
    check(`${i < 3 ? "直接下载" : "网页点击"}：${filename} 原件、名称和商品字段到达接收端`, saved.equals(g.image) && target?.filename === filename && target.name === g.name && Object.entries(values(g)).every(([key,value])=>target.fields[key] === value) && target.sha256 === hash(g.image), { target, savedBytes: saved.length });
  }
  check("每张图片只下载一次", goods.every(g => requests.filter(path => path === `GET /images/${g.sku}.png`).length === 1), { requests });
  const receipt = String(await rp.evaluate(work, 'document.querySelector("#receipt").textContent'));
  check("网页显示六张原图的接收哈希", goods.every(g => receipt.includes(hash(g.image))), { receipt });
  check("工作页未被下载替换，临时下载页已关闭", (await rp.targets()).filter(t => t.type === "page" && /\/images\//.test(t.url)).length === 0 && await rp.evaluate(work, 'location.href') === `${origin}/`, {});
  if (!live) check("伪造事件 handle 仍被宿主拒绝", [...toolResults].some(text => text.includes("unknown or model-minted event token")), {});
  if (!live) check("原件 base64 未进入模型工具结果", !leakedBase64, { scripted: true });
  await rp.screenshot(work, join(out, "received.png"));
  await rp.screenshot(panel, join(out, "answer.png"));
} catch (error) { check("流程完成", false, String(error)); }
finally {
  clearInterval(progress);
  if (panelId && live) {
    const journals = await rp.evaluate(panelId, `(async()=>{const root=await (await navigator.storage.getDirectory()).getDirectoryHandle('pi-durable');const out=[];async function walk(dir,path){for await(const [name,entry] of dir.entries()){if(entry.kind==='directory')await walk(entry,path+'/'+name);else if(name.endsWith('.jsonl')){const file=await entry.getFile();if(file.size<8000000)out.push({path:path+'/'+name,text:await file.text()});}}}await walk(root,'pi-durable');return out;})()`).catch(String);
    await writeFile(join(out, "journals.json"), JSON.stringify(journals, null, 2));
  }
  if (panelId) {
    const answer = await rp.evaluate(panelId, 'document.body.innerText').catch(String);
    await writeFile(join(out, "answer.txt"), String(answer));
    await rp.screenshot(panelId, join(out, "answer.png")).catch(() => {});
  }
  if (workId) await rp.screenshot(workId, join(out, "received.png")).catch(() => {});
  await writeFile(join(out, "result.json"), JSON.stringify({ live, thinking: thinking ?? "default", checks, received, requests, modelRequests: model.requests, toolResults: [...toolResults] }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}
console.log(`证据：${out}`);
if (checks.length !== (live ? 9 : 11) || checks.some(c => !c.pass)) process.exitCode = 1;
