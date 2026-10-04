/**
 * F1 inline PDF 只被打开，没有下载；F2 中断被说成完成；
 * F3 延迟下载重复启动；F4 file: 地址送到下载 API。
 * 真 PDF 阅读器、真侧栏、Chrome 下载目录；脚本模型只控制工具调用。
 */
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { configureViaSettings, loadModelPlan, modelStorageItems } from "./inproc-config.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const arxiv = process.argv.includes("--arxiv");

const live = process.argv.includes("--live") || arxiv;

const mainModel = process.argv.find(arg => arg.startsWith("--model="))?.slice(8) ?? "zai-coding-cn/glm-5.3-flash";

const out = join(REPO, "out/acceptance/pdf-download", new Date().toISOString().replace(/[:.]/g, "-"));

await mkdir(out, { recursive: true });

// 生成一页有效 PDF；xref 位置来自字节偏移，下载期望直接比较服务端原字节。
const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Contents 4 0 R >>", "<< /Length 0 >>\nstream\n\nendstream"];

let pdfText = "%PDF-1.4\n";

const offsets = [0];

for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdfText)); pdfText += `${i + 1} 0 obj\n${object}\nendobj\n`; }

const xref = Buffer.byteLength(pdfText);

pdfText += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

const pdf = Buffer.from(pdfText);

const requests: string[] = [];

const site = createServer((req, res) => {
  const path = req.url ?? "";
  requests.push(path);
  res.writeHead(200, { "content-type": "application/pdf", "content-disposition": 'inline; filename="paper.pdf"', "content-length": pdf.length });

  if (path === "/broken.pdf") { res.write(pdf.subarray(0, 40)); res.destroy();

 return; }

  if (path === "/slow.pdf") { res.write(pdf.subarray(0, 40)); setTimeout(() => res.end(pdf.subarray(40)), 4000);

 return; }

  res.end(pdf);
});

await new Promise<void>(r => site.listen(0, "127.0.0.1", r));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const sourceUrl = arxiv ? "https://arxiv.org/pdf/1706.03762" : `${origin}/paper.pdf`;

const rules: Rule[] = [
  { match: "下载阅读器", steps: [{ tool: { name: "download_url", args: { url: `${origin}/paper.pdf`, filename: "paper.pdf" } } }, { text: "PDF下载结果已返回。" }] },
  { match: "中断下载", steps: [{ tool: { name: "download_url", args: { url: `${origin}/broken.pdf`, filename: "broken.pdf", timeoutMs: 2000 } } }, { text: "这次下载没有完成。" }] },
  { match: "延迟下载", steps: [{ tool: { name: "download_url", args: { url: `${origin}/slow.pdf`, filename: "slow.pdf", timeoutMs: 1000 } } }, { text: "下载仍在进行，还没完成。" }] },
  { match: "拒绝本机地址并继续合法下载", steps: [{ tool: { name: "download_url", args: { url: "file:///private/does-not-exist.pdf" } } }, { tool: { name: "download_url", args: { url: `${origin}/paper.pdf`, filename: "after-invalid.pdf" } } }, { text: "本机地址已拒绝，合法 PDF 下载结果已返回。" }] },
];

const model = await startScriptedModel(rules);

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean }> = [];

let error: string | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "工作页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: sourceUrl }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await rp.evaluate(panel, `document.querySelector('#send-btn')?.disabled===false`)) || undefined, 60_000, "侧栏就绪");

  if (live) {
    const [providerId, ...modelParts] = mainModel.split("/");
    const key = process.env.SIDEAGENT_TEST_MAIN_KEY;
    const mainPlan = key ? { providerId: providerId!, modelId: modelParts.join("/"), credential: { type: "api_key", key } } : await loadModelPlan(mainModel);
    const items = modelStorageItems(mainPlan);
    const fastItems = modelStorageItems(await loadModelPlan("zai-coding-cn/glm-5.3-flash"));
    const { inproc_model_config: fastConfig, ...fastCredentials } = fastItems;
    Object.assign(items, fastCredentials, { inproc_fast_model_config: fastConfig });
    await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(()=>true)`);
  } else {
    const setup = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-probe" } }, { baseUrl: model.baseUrl });
    await rp.cdp.send("Target.closeTarget", { targetId: setup.settingsTargetId });
  }

  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });

  const run = async (text: string, name: string) => {
    await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel);
    await until(async () => live ? (await readdir(rp.dirs.downloads)).includes("paper.pdf") || undefined : model.requests.some(r => r.rule === text && r.step >= 1 && r.tools) || undefined, 90_000, "工具返回");
    await sleep(2000);
    await rp.screenshot(panel, join(out, `${name}.png`));
  };

  checks.push({ name: "viewer-does-not-download", pass: !(await readdir(rp.dirs.downloads)).some(n => n.endsWith(".pdf")) });
  await run(live ? "把当前阅读器里的 PDF 下载下来，文件名用 paper.pdf，等 Chrome 确认完成后告诉我。" : "下载阅读器", "complete");
  const hasFile = (await readdir(rp.dirs.downloads)).includes("paper.pdf");
  const downloaded = hasFile ? await readFile(join(rp.dirs.downloads, "paper.pdf")) : Buffer.alloc(0);
  checks.push({ name: "pdf-bytes", pass: hasFile && (arxiv ? downloaded.subarray(0, 5).toString() === "%PDF-" && downloaded.length > 1000 && downloaded.subarray(-100).toString().includes("%%EOF") : downloaded.equals(pdf)) });

  if (live) {
    const diagnostics = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(out, "diagnostics"));
    await writeFile(join(out, "traces.jsonl"), diagnostics.traces);
    checks.push({ name: "live-uses-chrome-download", pass: diagnostics.traces.includes('"toolName":"download_url"') || diagnostics.traces.includes('"toolName": "download_url"') });
  } else {
  await run("中断下载", "broken");
  const broken = await rp.evaluate(panel, `document.querySelector('#messages').innerText`);
  checks.push({ name: "broken-not-saved", pass: String(broken).includes("没有完成") && !(await readdir(rp.dirs.downloads)).includes("broken.pdf") });
  await run("延迟下载", "slow");
  await sleep(5000);
  const slow = await readFile(join(rp.dirs.downloads, "slow.pdf")).catch(() => Buffer.alloc(0));
  checks.push({ name: "slow-single-start", pass: slow.equals(pdf) && requests.filter(p => p === "/slow.pdf").length === 1 });
    await run("拒绝本机地址并继续合法下载", "invalid");
    const afterInvalid = await readFile(join(rp.dirs.downloads, "after-invalid.pdf")).catch(() => Buffer.alloc(0));
    checks.push({ name: "invalid-does-not-lock-next-download", pass: afterInvalid.equals(pdf) });
  const diagnostics = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(out, "diagnostics"));
  await writeFile(join(out, "traces.jsonl"), diagnostics.traces);
  const events = diagnostics.traces.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const interrupted = events.some(e => e.type === "tool_execution_end" && e.data?.toolName === "download_url" && JSON.stringify(e.data.result).includes("Download failed for"));
  checks.push({ name: "chrome-reports-interruption", pass: interrupted && requests.includes("/broken.pdf") });
    const rejected = events.some(e => e.type === "tool_execution_end" && e.data?.toolName === "download_url" && e.data?.isError === true && JSON.stringify(e.data.result).includes("下载链接必须是 HTTP 或 HTTPS 地址，操作未执行。"));
    checks.push({ name: "reject-before-api", pass: rejected && requests.every(path => path.startsWith("/")) });
  }

  await writeFile(join(out, "paper.pdf"), arxiv ? downloaded : pdf);
} catch (e) { error = String(e); console.error(error); }
finally {
  await writeFile(join(out, "summary.json"), JSON.stringify({ live, arxiv, mainModel, sourceUrl, checks, requests, error }, null, 2));
  await rp.close(); await model.close(); site.closeAllConnections(); site.close();
}

console.log(out, checks);

if (error || checks.length !== (live ? 3 : 7) || checks.some(c => !c.pass)) process.exitCode = 1;
