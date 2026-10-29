/**
 * 第二版侧栏：真实扩展侧栏、真实输入和会话路径；只有模型回复由本机脚本提供。
 *
 * npx tsx scripts/acceptance/real-path/sidebar-interaction.mts --headless --run=baseline
 * 产物：out/acceptance/sidebar-interaction/<run>/ 下的截图与 summary.json。
 */
import { useSavedSettingsModel } from './inproc-config.mts';
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const run = process.argv.find((arg) => arg.startsWith("--run="))?.slice(6) ?? "run";

if (!/^[a-z0-9-]+$/.test(run)) throw new Error("--run 只接受英文小写、数字和连字符");

const artifacts = join(REPO, "out/acceptance/sidebar-interaction", run);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>作者名单</title><body><h1>作者名单</h1><p>米娅负责编辑。</p></body></html>');
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const reply = "米娅负责编辑。\n\n名单中的职务来自当前页面。";

const rules: Rule[] = [{ match: "找米娅", steps: [{ text: reply, delayMs: 8_000 }] }];

const systemReading = (reading: { answerFont: string | null; answerSize: number | null; answerLineHeight: number | null }) =>
  reading.answerSize === 15 && reading.answerLineHeight != null && Math.abs(reading.answerLineHeight - 25.5) <= 1 &&
  !!reading.answerFont && /-apple-system|system-ui/.test(reading.answerFont) && !/Songti|STSong|SimSun/i.test(reading.answerFont);

const checks: Array<{ item: string; pass: boolean; detail: Json }> = [];

const shots: Array<{ state: string; file: string; layout: Json }> = [];

let error: string | null = null;

const check = (item: string, pass: boolean, detail: Json) => {
  checks.push({ item, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${item}: ${JSON.stringify(detail)}`);
};

const model = await startScriptedModel(rules);

let rp: Awaited<ReturnType<typeof launchRealPath>> | null = null;

try {
  rp = await launchRealPath();
  const blank = await until(async () => (await rp!.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/writers` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);

  // SAFETY: read() 的页面脚本返回的布局读数字段与下面的类型一一对应。
  const read = async () => await rp!.evaluate(panel, `(() => {
    const q = (s) => document.querySelector(s);
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right }; };
    const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const answer = [...document.querySelectorAll('.msg.assistant.markdown')].find((el) => el.textContent.includes('米娅负责编辑'));
    const style = answer ? getComputedStyle(answer) : null;
    const actions = answer?.querySelector('.answer-actions');
    return {
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      // 模型菜单里两层并排的滑轨被菜单自己裁掉，只看菜单本身有没有出界。
      overflow: [...document.querySelectorAll('#app *')].filter((el) => shown(el) && !el.closest('#think-menu .mm-views') && el.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map((el) => el.id || el.className || el.tagName),
      composer: rect(q('#composer')),
      starterShown: shown(q('#starter')),
      input: q('#input')?.value ?? '',
      sendStopping: q('#send-btn')?.classList.contains('stopping') ?? false,
      taskBar: shown(q('.task-bar')) ? { text: q('.task-bar').innerText, rect: rect(q('.task-bar')) } : null,
      answerText: answer?.innerText ?? null,
      answerFont: style?.fontFamily ?? null,
      answerSize: style ? Number.parseFloat(style.fontSize) : null,
      answerLineHeight: style ? Number.parseFloat(style.lineHeight) : null,
      actions: actions ? { rect: rect(actions), opacity: Number(getComputedStyle(actions).opacity), button: ((b) => b ? (b.getAttribute('aria-label') ?? (b.querySelector('.answer-face:not(.answer-face-done)') ?? b).textContent.replace('↵', '').trim()) : null)(actions.querySelector('button')), buttonRect: rect(actions.querySelector('button')) } : null,
      resultText: shown(q('#task-result-card')) ? q('#task-result-card').innerText : null,
    };
  })()`) as {
    viewport: number; documentWidth: number; overflow: string[];
    composer: { width: number } | null;
    starterShown: boolean; input: string; sendStopping: boolean;
    taskBar: { text: string; rect: { height: number } } | null;
    answerText: string | null; answerFont: string | null; answerSize: number | null;
    answerLineHeight: number | null;
    actions: { rect: { height: number }; opacity: number; button: string | null; buttonRect: { width: number; height: number } | null } | null;
    resultText: string | null;
  };

  const shot = async (state: string, width: number) => {
    await rp!.cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 2, mobile: false }, panel);
    await sleep(250);
    const layout = await read();
    const file = `${state}-${width}.png`;
    await rp!.screenshot(panel, join(artifacts, file));
    shots.push({ state, file, layout });

    return layout;
  };

  await until(async () => (await rp!.evaluate(panel, `document.querySelector('#status-dot')?.classList.contains('on')`)) || undefined, 60_000, "侧栏连接");
  await until(async () => (await rp!.evaluate(panel, `!document.querySelector('#send-btn')?.disabled && !document.querySelector('#conversation-new')?.disabled`)) || undefined, 60_000, "默认会话");

  const pressPoint = await rp.evaluate(panel, `(() => { const r = document.querySelector('#header-more').getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`);
  await rp.cdp.send("Input.dispatchMouseEvent", { type:"mousePressed", ...pressPoint, button:"left", clickCount:1 }, panel);
  await sleep(180);
  const pressed = await rp.evaluate(panel, `getComputedStyle(document.querySelector('#header-more')).transform`);
  check("按钮按下缩放为0.96", pressed === "matrix(0.96, 0, 0, 0.96, 0, 0)", pressed);
  await rp.cdp.send("Input.dispatchMouseEvent", { type:"mouseReleased", ...pressPoint, button:"left", clickCount:1 }, panel);
  await rp.click(panel, "#header-more"); // 收起按压检查打开的菜单

  await rp.click(panel, "#header-more");
  await rp.click(panel, "#model-settings-open");
  const settingsTarget = await until(async () => (await rp!.targets()).find((t) => t.type === "page" && t.url.split("#")[0]!.endsWith("/settings.html")), 10_000, "设置页");
  const settings = await rp.attach(settingsTarget.targetId);
  await until(async () => (await rp!.evaluate(settings, `document.querySelectorAll('.provider-option').length`)) > 3 || undefined, 15_000, "模型选项");
  await rp.click(settings, '[data-settings-page="connections"]');
  await rp.evaluate(settings, `document.querySelector('#provider-more').open = true; true`);
  await rp.click(settings, `.provider-option[data-provider="custom"]`);

  for (const [selector, value] of [["#base-url", model.baseUrl], ["#api-key", "local-demo-no-secret"], ["#model-id", "demo-model"]]) {
    await rp.evaluate(settings, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center' }); el.focus(); el.select?.(); return true; })()`);
    await rp.typeText(settings, value);
  }

  await rp.evaluate(settings, `document.querySelector('#model-save').scrollIntoView({ block: 'center' }); true`);
  await rp.click(settings, "#model-save");
  await until(async () => String(await rp!.evaluate(settings, `document.querySelector('#model-status').textContent`)).startsWith("已保存") || undefined, 10_000, "模型保存");
  await useSavedSettingsModel(rp, settings, 'custom', 'demo-model');
  // 保存前会先试连一次（10-13）：之后的「不发模型请求」从这里数起。
  const afterSave = model.requests.length;
  await rp.cdp.send("Target.closeTarget", { targetId: settingsTarget.targetId });
  await sleep(600);

  // 入口与菜单都走真实点击：模型只在输入框的芯片里切，菜单开在输入框上方、不能被别的层盖住。
  type ModelEntry = { inHeaderMenu: boolean; inComposer: boolean; visible: boolean; label: string };
  // SAFETY: 页面脚本返回的对象字段与 ModelEntry 一一对应。
  const readEntry = async () => await rp!.evaluate(panel, `(() => { const b = document.querySelector('#think-chip'); return { inHeaderMenu: !!document.querySelector('#header-menu #think-chip'), inComposer: !!document.querySelector('#composer #think-chip'), visible: !!b && !b.hidden && b.getClientRects().length > 0 && getComputedStyle(b).visibility === 'visible', label: b?.innerText ?? '' }; })()`) as ModelEntry;
  // 芯片在输入框的工具行里：用户先点输入框，工具行才展开；芯片还要等宿主报出当前模型才显示。
  await rp.click(panel, "#input");
  await until(async () => (await readEntry()).visible || undefined, 10_000, "模型芯片出现").catch(() => undefined);
  const modelEntry = await readEntry();
  check("当前模型入口在输入框芯片上、不在更多菜单内", modelEntry.inComposer && !modelEntry.inHeaderMenu && modelEntry.visible, modelEntry);

  if (modelEntry.visible) {
    await rp.click(panel, "#think-chip");
    await sleep(350);

    // SAFETY: 页面脚本返回 null 或下面这个字段固定的对象。
    const modelMenu = await rp.evaluate(panel, `(() => {
      const m = document.querySelector('#think-menu'); const row = m?.querySelector('.mm-main .mm-row[data-model]');
      if (!m || !row) return null;
      const r = row.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { open: m.classList.contains('open'), rowVisible: row.getClientRects().length > 0, rowHit: hit === row || row.contains(hit), expanded: document.querySelector('#think-chip').getAttribute('aria-expanded') };
    })()`) as { open: boolean; rowVisible: boolean; rowHit: boolean; expanded: string | null } | null;

    check("点模型芯片后菜单可见且第一行能点到", !!modelMenu?.open && !!modelMenu.rowVisible && !!modelMenu.rowHit, modelMenu);
    await shot("0-model-open", 400);
    const escape = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...escape }, panel);
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...escape }, panel);
    await until(async () => (await rp!.evaluate(panel, `!document.querySelector('#think-menu').classList.contains('open')`)) || undefined, 5_000, "Escape 收起模型菜单");
    const escapeFocus = String(await rp.evaluate(panel, `document.activeElement?.id ?? ''`));
    check("Escape 收起模型菜单后焦点回芯片", escapeFocus === "think-chip", { activeElement: escapeFocus });

    await rp.click(panel, "#think-chip");
    await until(async () => (await rp!.evaluate(panel, `document.querySelector('#think-menu').classList.contains('open')`)) || undefined, 5_000, "再次打开模型菜单");
    const currentModel = String(await rp.evaluate(panel, `document.querySelector('#think-menu .mm-main .mm-row[aria-checked="true"]')?.getAttribute('data-model') ?? ''`));
    check("菜单里标出当前模型", !!currentModel, { model: currentModel });

    if (currentModel) {
      await rp.click(panel, '#think-menu .mm-main .mm-row[aria-checked="true"]');
      // SAFETY: 页面表达式固定返回 closed 与 focus 两个字段。
      const selection = await rp.evaluate(panel, `({ closed: !document.querySelector('#think-menu').classList.contains('open'), focus: document.activeElement?.id ?? '' })`) as { closed: boolean; focus: string };
      check("点当前模型收起菜单后焦点回芯片", selection.closed && selection.focus === "think-chip", { model: currentModel, ...selection });
    }

    await rp.click(panel, "#input");
  } else {
    check("点模型芯片后菜单可见且第一行能点到", false, { reason: "模型芯片不可见" });
  }

  // Real content script, closed shadow DOM and background relay; no model request on transfer.
  await rp.evaluate(work, `(() => { const r=document.createRange(); r.selectNodeContents(document.querySelector('p')); const s=getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
  const worker = await rp.attach((await rp.serviceWorker())!.targetId);
  await rp.evaluate(worker, `chrome.tabs.query({}).then(tabs => { const t=tabs.find(t => t.url === ${JSON.stringify(`${origin}/writers`)}); return chrome.tabs.sendMessage(t.id,{type:'ask-hotkey'}); })`);

  type ShadowNode = { attributes?: string[]; children?: ShadowNode[]; shadowRoots?: ShadowNode[]; backendNodeId: number };

  const shadow = await until(async () => {
    const doc = await rp!.cdp.send("DOM.getDocument", { depth:-1, pierce:true }, work);
    const find = (node: ShadowNode): ShadowNode | undefined => node.attributes?.includes('data-sideagent-ask') ? node : [...(node.children ?? []), ...(node.shadowRoots ?? [])].map(find).find(Boolean);
    const host = find(doc.root);

    if (!host?.shadowRoots?.[0]) return undefined;

    return (await rp!.cdp.send("DOM.resolveNode", { backendNodeId:host.shadowRoots[0].backendNodeId }, work)).object.objectId;
  }, 5000, "划词阅读卡");

  const shadowRead = async (expression: string) => (await rp!.cdp.send("Runtime.callFunctionOn", { objectId:shadow, returnByValue:true, functionDeclaration:`function(){return ${expression};}` }, work)).result.value;
  await until(async () => await shadowRead(`this.querySelector('.surface').classList.contains('expanded')`) || undefined, 5000, "快捷键消息展开阅读卡");
  for (const action of ["close", "more", "transfer"]) {
    const point = await until(async () => await shadowRead(`(() => {const e=this.querySelector('[data-act="${action}"]');const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=this.elementFromPoint(x,y);return r.width>0&&r.height>0&&(hit===e||e.contains(hit))?{x,y}:null})()`), 5000, `划词操作 ${action} 可点击`);
    await rp.cdp.send("Input.dispatchMouseEvent", { type:"mousePressed", ...point, button:"left", clickCount:1 }, work);
    await rp.cdp.send("Input.dispatchMouseEvent", { type:"mouseReleased", ...point, button:"left", clickCount:1 }, work);
    if (action === "close") {
      const textPoint = await rp.evaluate(work, "(() => {const r=document.querySelector('p').getBoundingClientRect();return {x:r.x+5,y:r.y+r.height/2}})()");
      await rp.cdp.send("Input.dispatchMouseEvent", { type:"mousePressed", ...textPoint, button:"left", clickCount:3 }, work);
      await rp.cdp.send("Input.dispatchMouseEvent", { type:"mouseReleased", ...textPoint, button:"left", clickCount:3 }, work);
    }
  }
  await until(async () => await rp!.evaluate(panel, `!document.querySelector('#ask-cite').hidden`) || undefined, 5000, "选区转入引用");
  const cite = await rp.evaluate(panel, `({ text:document.querySelector('#ask-cite-text').textContent, host:document.querySelector('#ask-cite-host').textContent, focus:document.activeElement.id })`);
  check("划词转入保留原文、站点和输入焦点且不发模型请求", cite.text === "米娅负责编辑。" && cite.host.startsWith('127.0.0.1') && cite.focus === 'input' && model.requests.length === afterSave, cite);
  await rp.typeText(panel, "引用草稿");
  await rp.screenshot(panel, join(artifacts, "selection-cite.png"));
  if (await rp.evaluate(panel, `document.querySelector("#materials-tray-root .mt-toggle")?.getAttribute("aria-expanded") !== "true"`)) await rp.click(panel, "#materials-tray-root .mt-toggle");
  await rp.click(panel, "#materials-tray-root .mt-row[data-kind='selection']");
  await rp.click(panel, "#materials-tray-root .mt-remove");
  const removed = await rp.evaluate(panel, `({hidden:document.querySelector('#ask-cite').hidden,input:document.querySelector('#input').value})`);
  check("去掉引用不清空正文", removed.hidden && removed.input === '引用草稿', removed);
  await rp.evaluate(panel, `document.querySelector('#input').value='';document.querySelector('#input').dispatchEvent(new Event('input',{bubbles:true}));`);
  await rp.detach(worker);

  const idle = await shot("1-idle", 400);
  check("空会话问候可见", idle.starterShown, { shown: idle.starterShown });
  await rp.click(panel, "#input");
  await rp.typeText(panel, "上一段草稿");
  await rp.click(panel, "#conversation-new");
  await until(async () => (await read()).input === "" || undefined, 10_000, "新会话草稿为空");
  check("新会话不继承上一段草稿", (await read()).input === "", { input: (await read()).input });

  await rp.click(panel, "#input");
  await rp.typeText(panel, "请在当前页找米娅");
  await rp.pressEnter(panel);
  await until(async () => model.requests.some((r) => r.rule === "找米娅") || undefined, 30_000, "真实发送抵达脚本模型");
  const running = await shot("2-running", 400);
  // #58 C：不再有重复目标的厚任务卡；过程只有一行，点开是步骤，减少动态效果时不扫光。
  check("真实运行不再生成重复目标的任务卡", await rp.evaluate(panel, `!document.querySelector('.ai-task-card .task-goal-line')?.getClientRects().length`), null);
  const line = await until(async () => await rp.evaluate(panel, `document.querySelector("details.run-steps .run-title")?.textContent || ""`) || undefined, 20_000, "过程行");
  check("过程只有一行，写在做什么", /^正在|^做了/.test(String(line)), { line });
  await rp.cdp.send("Emulation.setEmulatedMedia", {features:[{name:"prefers-reduced-motion",value:"reduce"}]}, panel);
  check("减少动态效果时过程行不扫光", await rp.evaluate(panel, `(() => { const t = document.querySelector("details.run-steps .run-title"); return !t || getComputedStyle(t).animationName === "none"; })()`), null);
  await rp.cdp.send("Emulation.setEmulatedMedia", {features:[]}, panel);


  check("运行中仍可输入补充", running.sendStopping && !(await rp.evaluate(panel, `document.querySelector('#input').disabled`)), { sendStopping: running.sendStopping });
  await until(async () => (await read()).answerText?.includes(reply.split("\n")[0]!) || undefined, 60_000, "回答落入真实侧栏");
  await until(async () => !!(await read()).actions || undefined, 15_000, "回答操作出现");

  // 与本任务的红基线实测读数成对校准：sans-serif 是系统字体回退项，不应误判为 serif 阅读档。
  const baselineReading = { answerFont: '"Songti SC", STSong, "Songti TC", SimSun, serif', answerSize: 15, answerLineHeight: 27 };
  const currentReading = await read();
  check("阅读判据校准：系统栈通过、红基线宋体失败", systemReading(currentReading) && !systemReading(baselineReading), { current: { font: currentReading.answerFont, size: currentReading.answerSize, lineHeight: currentReading.answerLineHeight }, baseline: baselineReading });

  // 每个回答一个主动作（#351），是一个短的文字按钮「复制」，不再是 32px 的图标。
  for (const width of [360, 400, 440]) {
    const done = await shot("3-done", width);
    check(`${width}px 无横向溢出`, done.documentWidth <= width + 1 && done.overflow.length === 0, { documentWidth: done.documentWidth, overflow: done.overflow });
    check(`${width}px 回答为系统字体 15px、约 26px 行高`, systemReading(done), { font: done.answerFont, size: done.answerSize, lineHeight: done.answerLineHeight });
    check(`${width}px 复制操作可见且紧凑`, !!done.actions && done.actions.opacity >= 0.9 && done.actions.rect.height <= 30 && /^复制/.test(done.actions.button ?? "") && !!done.actions.buttonRect && done.actions.buttonRect.width <= 80, done.actions);
    check(`${width}px 完成后输入框上方不重复已完成`, !done.taskBar && !(done.resultText ?? "").includes("已完成"), { taskBar: done.taskBar, resultText: done.resultText });
  }

  check("模型请求来自真实发送", model.requests.some((r) => r.rule === "找米娅" && r.status === 200), model.requests);
} catch (cause) {
  error = cause instanceof Error ? cause.stack ?? cause.message : String(cause);
  console.error(error);
} finally {
  await writeFile(join(artifacts, "summary.json"), JSON.stringify({ at: new Date().toISOString(), run, browser: rp?.browser ?? null, model: "local scripted-model", modelRequests: model.requests, shots, checks, notCovered: ["成功恢复回执无页面动作的真实结束路径未触发", "运行中补充、停止和切回旧会话草稿未触发"], error }, null, 2));

  if (rp) { await rp.close(); await rp.remove(); }

  await model.close();
  site.close();
}

console.log(`${checks.filter((c) => c.pass).length}/${checks.length} 通过；截图和读数：${artifacts}`);

process.exit(error || checks.some((c) => !c.pass) ? 1 : 0);
