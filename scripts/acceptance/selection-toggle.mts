/**
 * 划词工具条开关：隔离 headless Chrome 加载真实构建的扩展，用 CDP 真实鼠标拖选网页文字、
 * 真实鼠标点设置页开关，检查「问 AI / 解释」工具条是否按开关出现。
 * 构建输出到临时目录，不覆盖日常 Chrome 加载的 extension/dist；结束时核对日常 dist 未变。
 * 用法：npx tsx scripts/acceptance/selection-toggle.mts
 * 产物：out/selection-toggle/<时间>/result.json 与每步截图。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCdp, fetchJson } from "./cdp.mjs";

const PAGE = `<!doctype html><meta charset="utf-8"><title>划词开关探针</title>
<body style="font:18px/1.8 sans-serif;margin:60px;max-width:640px">
<p id="a">第一段：光合作用把光能转成化学能，植物靠它制造养分。</p>
<p id="b" style="margin-top:80px">第二段：潮汐主要由月球引力造成，太阳的作用次之。</p>
</body>`;

const repo = process.cwd();

const out = resolve("out/selection-toggle", new Date().toISOString().replace(/[:.]/g, "-"));

await mkdir(out, { recursive: true });

const dailyHash = async () => createHash("sha256").update(await readFile(join(repo, "extension/dist/content-ask.js")).catch(() => Buffer.from(""))).digest("hex");

const dailyBefore = await dailyHash();

const buildRoot = await mkdtemp(join(tmpdir(), "bys-selection-toggle-"));

const build = spawnSync("node", ["build.mjs"], { cwd: join(repo, "extension"), env: { ...process.env, SIDEAGENT_BUILD_DIST: join(buildRoot, "extension/dist") }, encoding: "utf8" });

if (build.status !== 0) throw new Error(`隔离构建失败：${build.stderr}`);

process.chdir(buildRoot);

const { launchIsolatedExtension, sleep, until } = await import("./isolated-extension.mts");

const iso = await launchIsolatedExtension({ fixtureHtml: PAGE, localOnly: true });

const steps: Array<{ step: string; expected: unknown; actual: unknown; pass: boolean }> = [];

try {
  const port = (await readFile(join(iso.outDir, "profile", "DevToolsActivePort"), "utf8")).split("\n")[0];
  const cdp = createCdp((await fetchJson(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl);
  await cdp.ready();

  const extensionId = String(await iso.swEval("chrome.runtime.id"));
  const page = await iso.newTarget(`${iso.fixtureOrigin}/`);
  const pageSession = await cdp.attachSession(page);
  await until(() => iso.evalIn(page, "document.readyState === 'complete' && !!document.querySelector('[data-sideagent-ask]')"), 10_000, "content script");

  const mouse = async (session: string, type: string, x: number, y: number) =>
    cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 }, session);

  /** 真实鼠标从段落首字拖到末字。 */
  const dragSelect = async (id: string) => {
    const r = await iso.evalIn(page, `(()=>{const b=document.getElementById('${id}').getBoundingClientRect();return {x0:b.left+2,x1:b.left+Math.min(b.width,560)-4,y:b.top+b.height/2}})()`);
    await mouse(pageSession, "mousePressed", r.x0, r.y);

    for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x0 + (r.x1 - r.x0) * i / 8, y: r.y, button: "left", buttons: 1 }, pageSession);
    await mouse(pageSession, "mouseReleased", r.x1, r.y);
    await sleep(500);
  };

  /** 点空白处清掉选区与工具条。 */
  const clickBlank = async () => {
    await mouse(pageSession, "mousePressed", 700, 20);
    await mouse(pageSession, "mouseReleased", 700, 20);
    await sleep(300);
  };

  /** 读 closed shadow root 里工具条的状态。 */
  const barState = async (): Promise<{ selected: string; surfaceVisible: boolean; expanded: boolean }> => {
    const doc = await cdp.send("DOM.getDocument", { depth: -1, pierce: true }, pageSession);

    const find = (node: any): any => {
      if (node.attributes?.includes("data-sideagent-ask")) return node;

      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        const found = find(child);

        if (found) return found;
      }
    };

    const host = find(doc.root);
    const resolved = await cdp.send("DOM.resolveNode", { backendNodeId: host.shadowRoots[0].backendNodeId }, pageSession);
    const result = await cdp.send("Runtime.callFunctionOn", { objectId: resolved.object.objectId, returnByValue: true, functionDeclaration: "function(){const s=this.querySelector('.surface');return {surfaceVisible:!s.hidden&&s.getBoundingClientRect().width>0,expanded:s.classList.contains('expanded')}}" }, pageSession);

    return { selected: String(await iso.evalIn(page, "getSelection().toString().trim()")), ...result.result.value };
  };

  const check = async (step: string, expected: Record<string, boolean | string | number | null>) => {
    const actual = await barState();
    // SAFETY: 只按键名读 barState 返回的普通字段做相等比较，缺的键读出 undefined 即不相等。
    const pass = Object.entries(expected).every(([k, v]) => (actual as Record<string, boolean | string | number | null | undefined>)[k] === v || (k === "selectedNonEmpty" && Boolean(actual.selected) === v));
    steps.push({ step, expected, actual, pass });
    await iso.screenshot(page, join(out, `${steps.length}-page.png`));
    console.log(`${pass ? "PASS" : "FAIL"} ${step}`, JSON.stringify(actual));
  };

  /** 在设置页用真实鼠标点「划词」开关，返回点完后的勾选状态与提示文字。 */
  const toggleInSettings = async (label: string) => {
    const settings = await iso.newTarget(`chrome-extension://${extensionId}/settings.html`);
    const session = await cdp.attachSession(settings);
    await until(() => iso.evalIn(settings, "!!document.getElementById('selection-bar')"), 10_000, "settings page");
    await sleep(500);
    const before = await iso.evalIn(settings, "document.getElementById('selection-bar').checked");
    const r = await iso.evalIn(settings, "(()=>{const e=document.getElementById('selection-bar');e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()");
    await mouse(session, "mousePressed", r.x, r.y);
    await mouse(session, "mouseReleased", r.x, r.y);
    await until(() => iso.evalIn(settings, "document.getElementById('selection-status').textContent"), 5_000, "save status");
    const after = await iso.evalIn(settings, "({checked:document.getElementById('selection-bar').checked,status:document.getElementById('selection-status').textContent})");
    const stored = await iso.swEval("chrome.storage.local.get('sideagent_selection_bar').then(v=>v.sideagent_selection_bar)");
    await iso.screenshot(settings, join(out, `settings-${label}.png`));
    await iso.closeTarget(settings);
    const pass = before !== after.checked && stored === after.checked;
    steps.push({ step: `设置页点开关（${label}）`, expected: { checkedFlips: true, storedMatches: true }, actual: { before, ...after, stored }, pass });
    console.log(`${pass ? "PASS" : "FAIL"} 设置页点开关（${label}）`, JSON.stringify({ before, ...after, stored }));

    // SAFETY: after 由设置页脚本返回，checked 是复选框的布尔值。
    return after.checked as boolean;
  };

  await dragSelect("a");
  await check("默认：拖选文字后出现工具条", { selectedNonEmpty: true, surfaceVisible: true });
  await clickBlank();

  const off = await toggleInSettings("关闭");
  await iso.evalIn(page, "void 0");
  await dragSelect("b");
  await check(`关闭后（页面未刷新）：拖选文字不出现工具条（开关=${off}）`, { selectedNonEmpty: true, surfaceVisible: false });

  // ⌘J / 右键菜单在后台都是给内容脚本发 ask-open；headless 无法按扩展快捷键，这里直接发同一条消息。
  await iso.swEval(`chrome.tabs.query({}).then(ts=>{const t=ts.find(t=>t.url?.startsWith(${JSON.stringify(iso.fixtureOrigin)}));return chrome.tabs.sendMessage(t.id,{type:'ask-open'}).catch(()=>{})})`);
  await sleep(800);
  await check("关闭后：主动打开（ask-open）仍然展开阅读卡", { surfaceVisible: true, expanded: true });
  await iso.evalIn(page, "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
  await clickBlank();

  const settingsAgain = await iso.newTarget(`chrome-extension://${extensionId}/settings.html`);
  await until(() => iso.evalIn(settingsAgain, "!!document.getElementById('selection-bar')"), 10_000, "settings reopen");
  await sleep(500);
  const persisted = await iso.evalIn(settingsAgain, "document.getElementById('selection-bar').checked");
  steps.push({ step: "重开设置页：开关保持关闭", expected: false, actual: persisted, pass: persisted === false });
  console.log(`${persisted === false ? "PASS" : "FAIL"} 重开设置页：开关保持关闭`, persisted);
  await iso.closeTarget(settingsAgain);

  await toggleInSettings("重新开启");
  await dragSelect("a");
  await check("重新开启后（页面未刷新）：拖选文字又出现工具条", { selectedNonEmpty: true, surfaceVisible: true });

  await cdp.close().catch(() => {});
} finally {
  const dailyUnchanged = (await dailyHash()) === dailyBefore;
  steps.push({ step: "日常 extension/dist 未被覆盖", expected: true, actual: dailyUnchanged, pass: dailyUnchanged });
  const passed = steps.length > 0 && steps.every(s => s.pass);
  await writeFile(join(out, "result.json"), JSON.stringify({ passed, steps }, null, 2));
  console.log(`\n${passed ? "ALL PASS" : "FAILED"} → ${out}/result.json`);
  await iso.close();
  process.exitCode = passed ? 0 : 1;
}
