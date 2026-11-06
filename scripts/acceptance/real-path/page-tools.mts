import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-page-tools`);

await mkdir(artifacts, { recursive: true });

const clip = join(artifacts, "clip.webm");
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=5:d=60", "-c:v", "libvpx-vp9", "-b:v", "60k", clip]);
const video = await readFile(clip);

const vtt = (lines: string[]) => `WEBVTT\n\n${lines.map((line, i) => `00:00:${String(i * 5).padStart(2, "0")}.000 --> 00:00:${String(i * 5 + 4).padStart(2, "0")}.000\n${line}`).join("\n\n")}\n`;
const COFFEE = ["第一句讲水温", "第二句讲研磨", "第三句讲水温和时间", "第四句讲粉水比"];
const BILL = ["账单第一句", "账单第二句"];

const page = (title: string, track: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><video id="v" src="/clip.webm" muted width="320">${track}</video>`;

const site = createServer((req, res) => {
  const url = req.url ?? "/";

  if (url === "/clip.webm") { res.writeHead(200, { "content-type": "video/webm", "accept-ranges": "bytes", "content-length": video.length }).end(video); return; }

  if (url === "/coffee.vtt") { res.writeHead(200, { "content-type": "text/vtt; charset=utf-8" }).end(vtt(COFFEE)); return; }

  if (url === "/bill.vtt") { res.writeHead(200, { "content-type": "text/vtt; charset=utf-8" }).end(vtt(BILL)); return; }

  const html = url === "/bill" ? page("电费账单", '<track default kind="captions" srclang="zh" src="/bill.vtt">') : url === "/silent" ? page("没有字幕", "") : page("手冲咖啡", '<track default kind="captions" srclang="zh" src="/coffee.vtt">');
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const TOOL = `做好了。
<app title="字幕搜索">
<style>#q{width:100%;height:30px}#list{max-height:300px;overflow:auto}button.row{display:block;width:100%;height:36px;text-align:left}#msg{height:24px}</style>
<input id="q" placeholder="搜索"><div id="msg"></div><div id="list"></div>
<script>
const list=document.getElementById("list"),msg=document.getElementById("msg");
let cues=[];
const draw=()=>{const q=document.getElementById("q").value;list.innerHTML="";for(const c of cues.filter(c=>c.text.includes(q))){const b=document.createElement("button");b.className="row";b.textContent=c.text;b.onclick=()=>bys.page.seek(c.start).catch(e=>{msg.textContent=e.message});list.append(b)}};
document.getElementById("q").oninput=draw;
bys.page.captions().then(r=>{if(r.status!=="ok"){msg.textContent=r.message;bys.say("状态："+r.status);return}cues=r.cues;draw();bys.say("读到 "+cues.length+" 句")}).catch(e=>{msg.textContent=e.message});
setTimeout(()=>bys.page.seek(40).then(()=>bys.say("自动跳转成功")).catch(e=>bys.say("自动跳转被拒："+e.message)),7000);
</script>
</app>`;

const model = await startScriptedModel([{ match: "字幕", steps: [{ text: TOOL }] }]);
const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

let panelSession: string | undefined;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  const go = async (path: string) => { await rp.cdp.send("Page.navigate", { url: `${origin}${path}` }, work); await until(async () => await rp.evaluate(work, `document.querySelector("#v")?.readyState >= 1`) || undefined, 15_000, `打开 ${path}`); };
  await go("/coffee");
  const panel = await rp.attach(await rp.openSidePanel());
  panelSession = panel;
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ sideagent_mini_apps: true, inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && document.querySelector("#conversation-new")?.disabled===false') || undefined, 60_000, "sidebar ready");
  const lastApp = `[...document.querySelectorAll("#messages .gc-app:not(.gc-ph)")].at(-1)`;
  const bar = async () => await rp.evaluate(panel, `(() => { const b = ${lastApp}?.querySelector(".gc-app-bar"); return b && !b.hidden ? b.textContent : ""; })()`) as string;
  const waitBar = (text: string, ms = 15_000) => until(async () => { const b = await bar(); return b.includes(text) ? b : undefined; }, ms, `提示「${text}」`);
  const clickInApp = async (x: number, y: number) => {
    await rp.evaluate(panel, `${lastApp}.scrollIntoView({ block: "center" }), true`);
    await sleep(150);
    const r = await rp.evaluate(panel, `(() => { const r = ${lastApp}.querySelector("iframe").getBoundingClientRect(); return { x: r.x, y: r.y }; })()`) as { x: number; y: number };

    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) await rp.cdp.send("Input.dispatchMouseEvent", { type, x: r.x + x, y: r.y + y, button: "left", clickCount: 1 }, panel);
  };
  const time = () => rp.evaluate(work, `document.querySelector("#v").currentTime`) as Promise<number>;
  const frameHeight = () => rp.evaluate(panel, `${lastApp}.querySelector("iframe").getBoundingClientRect().height`) as Promise<number>;
  const foot = () => rp.evaluate(panel, `${lastApp}.querySelector(".gc-app-foot")?.textContent ?? ""`) as Promise<string>;

  await rp.click(panel, "#input");
  await rp.typeText(panel, "提取字幕，能搜索，点一句跳到对应时间");
  await rp.pressEnter(panel);
  evidence.read = await waitBar("读到 4 句");
  assert.equal(await rp.evaluate(panel, `${lastApp}.querySelector(".gc-app-note").textContent`), "只读这一页 · 不联网", "note says what the tool touches");
  await rp.screenshot(panel, join(artifacts, "1-tool.png"));

  assert.equal(await time(), 0, "reading does not move the video");
  await waitBar("跳到视频", 12_000);
  assert.equal(await time(), 0, "a proposed seek without the host button leaves the video untouched");
  await rp.evaluate(panel, `${lastApp}.querySelector(".gc-app-bar button:last-child").id="cancel-tool-seek";true`);
  await rp.click(panel, "#cancel-tool-seek");
  const refused = await waitBar("自动跳转", 12_000);
  evidence.autoSeek = refused;
  assert.ok(refused.includes("自动跳转被拒"), `a seek with no user click is refused: ${refused}`);
  assert.equal(await time(), 0, "the refused seek did not move the video");

  await clickInApp(60, 12 + 30 + 24 + 36 * 2 + 18);
  await waitBar("跳到视频");
  assert.equal(await time(), 0, "the tool does not turn its own click into authority");
  await rp.evaluate(panel, `${lastApp}.querySelector(".gc-app-bar button").id="confirm-tool-seek";true`);
  await rp.click(panel, "#confirm-tool-seek");
  const seeked = await until(async () => { const t = await time(); return t >= 10 ? t : undefined; }, 8_000, "点第三句后视频跳到 10 秒");
  evidence.clickSeek = seeked;
  assert.ok(seeked < 14, `seek landed on the clicked line: ${seeked}`);

  const before = await frameHeight();
  await clickInApp(60, 27);
  await rp.typeText(panel, "时间");
  await sleep(500);
  assert.equal(await frameHeight(), before, "filtering keeps the frame height");
  await rp.screenshot(panel, join(artifacts, "2-search.png"));

  await rp.evaluate(panel, `${lastApp}.querySelector(".gc-app-foot button").click(), true`);
  await sleep(200);
  await rp.screenshot(panel, join(artifacts, "3-save-form.png"));
  const form = await foot();
  evidence.form = form;
  assert.ok(form.includes("127.0.0.1") && form.includes("让视频跳转"), `form states where it applies and what it can do: ${form}`);
  await rp.evaluate(panel, `${lastApp}.querySelector(".gc-app-foot button.primary").click(), true`);
  await until(async () => (await foot()).includes("已保存") || undefined, 5_000, "显示已保存");
  const stored = await rp.evaluate(panel, `chrome.storage.local.get("sideagent_saved_tools").then(s => s.sideagent_saved_tools.map(t => ({ name: t.name, site: t.site, canSeek: t.canSeek })))`) as Array<{ name: string; site: string; canSeek: boolean }>;
  assert.deepEqual(stored, [{ name: "字幕搜索", site: origin, canSeek: true }], "the tool is saved for this site");

  const requests = () => model.requests.length;
  const asked = requests();
  await go("/bill");
  evidence.stale = await waitBar("上一个页面");
  await rp.screenshot(panel, join(artifacts, "4-stale.png"));
  await clickInApp(60, 12 + 30 + 24 + 18);
  await sleep(600);
  assert.ok(await time() < 1, "the old tool cannot move the new video");

  await rp.click(panel, "#input");
  await rp.typeText(panel, "/");
  await until(async () => await rp.evaluate(panel, `!!document.querySelector("#pskill-menu [data-saved-tool]")`) || undefined, 5_000, "/ 菜单里有保存的工具");
  await rp.screenshot(panel, join(artifacts, "5-slash.png"));
  await rp.evaluate(panel, `document.querySelector("#pskill-menu [data-saved-tool]").click(), true`);
  evidence.reopened = await waitBar("读到 2 句");
  assert.equal(requests(), asked, "opening a saved tool does not call the model");
  await rp.screenshot(panel, join(artifacts, "6-new-video.png"));
  await clickInApp(60, 12 + 30 + 24 + 36 + 18);
  await waitBar("跳到视频");
  await rp.evaluate(panel, `${lastApp}.querySelector(".gc-app-bar button").id="confirm-bill-seek";true`);
  await rp.click(panel, "#confirm-bill-seek");
  const billSeek = await until(async () => { const t = await time(); return t >= 5 ? t : undefined; }, 8_000, "新视频跳到第二句");
  evidence.billSeek = billSeek;

  await go("/silent");
  await waitBar("上一个页面");
  await rp.evaluate(panel, `${lastApp}.querySelector(".gc-app-bar button").id="reload-tool-page";true`);
  await rp.click(panel, "#reload-tool-page");
  evidence.none = await waitBar("状态：");
  await rp.screenshot(panel, join(artifacts, "7-no-captions.png"));
  assert.equal(await foot(), "", "a tool with nothing to read offers no save");

  await go("/coffee");
  await rp.cdp.send("Page.reload", {}, panel);
  await until(async () => await rp.evaluate(panel, `document.querySelectorAll("#messages .gc-app").length >= 1`) || undefined, 30_000, "重开后回放");
  evidence.replay = await until(async () => { const bars = await rp.evaluate(panel, `[...document.querySelectorAll("#messages .gc-app-bar")].filter(b => !b.hidden).map(b => b.textContent).join("|")`) as string; return bars.includes("读当前页面的字幕") ? bars : undefined; }, 15_000, "历史工具等用户点读取");
  await rp.screenshot(panel, join(artifacts, "8-replay.png"));

  await rp.evaluate(panel, `chrome.storage.local.set({ sideagent_saved_tools: [] }).then(() => true)`);
  await rp.click(panel, "#input");
  await rp.typeText(panel, "/");
  await sleep(500);
  assert.equal(await rp.evaluate(panel, `!!document.querySelector("#pskill-menu [data-saved-tool]")`), false, "a deleted tool leaves the menu");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (panelSession) {
    await rp.screenshot(panelSession, join(artifacts, "failure.png")).catch(() => {});
    evidence.bars = await rp.evaluate(panelSession, `[...document.querySelectorAll("#messages .gc-app")].map(a => ({ cls: a.className, note: a.querySelector(".gc-app-note")?.textContent, bar: a.querySelector(".gc-app-bar")?.textContent, frame: !!a.querySelector("iframe") }))`).catch(() => null);
  }
} finally {
  await writeFile(join(artifacts, "evidence.json"), JSON.stringify({ error, evidence }, null, 2));
  await rp.close?.();
  await model.close?.();
  site.close();
}
console.log(JSON.stringify({ artifacts, error, evidence }, null, 2).slice(0, 2500));
process.exit(error ? 1 : 0);
