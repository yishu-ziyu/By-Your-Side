/**
 * 第二版侧栏：真实扩展侧栏、真实输入和会话路径；只有模型回复由本机脚本提供。
 *
 * npx tsx scripts/acceptance/real-path/sidebar-interaction.mts --headless --run=baseline
 * 产物：out/acceptance/sidebar-interaction/<run>/ 下的截图与 summary.json。
 */
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
  rp = await launchRealPath({ withoutNativeHost: true });
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
      overflow: [...document.querySelectorAll('#app *')].filter((el) => shown(el) && el.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map((el) => el.id || el.className || el.tagName),
      pageInComposer: !!q('#composer #page-pill') && shown(q('#page-pill')),
      pagePill: rect(q('#page-pill')),
      composer: rect(q('#composer')),
      starterShown: shown(q('#starter')),
      input: q('#input')?.value ?? '',
      sendStopping: q('#send-btn')?.classList.contains('stopping') ?? false,
      taskBar: shown(q('.task-bar')) ? { text: q('.task-bar').innerText, rect: rect(q('.task-bar')) } : null,
      answerText: answer?.innerText ?? null,
      answerFont: style?.fontFamily ?? null,
      answerSize: style ? Number.parseFloat(style.fontSize) : null,
      answerLineHeight: style ? Number.parseFloat(style.lineHeight) : null,
      actions: actions ? { rect: rect(actions), opacity: Number(getComputedStyle(actions).opacity), button: actions.querySelector('button')?.getAttribute('aria-label') ?? null, buttonRect: rect(actions.querySelector('button')) } : null,
      resultText: shown(q('#task-result-card')) ? q('#task-result-card').innerText : null,
    };
  })()`) as {
    viewport: number; documentWidth: number; overflow: string[]; pageInComposer: boolean;
    pagePill: { width: number } | null; composer: { width: number } | null;
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
  const settingsTarget = await until(async () => (await rp!.targets()).find((t) => t.type === "page" && t.url.endsWith("/settings.html")), 10_000, "设置页");
  const settings = await rp.attach(settingsTarget.targetId);
  await until(async () => (await rp!.evaluate(settings, `document.querySelectorAll('.provider-option').length`)) > 3 || undefined, 15_000, "模型选项");
  await rp.evaluate(settings, `document.querySelector('#provider-more').open = true; true`);
  await rp.click(settings, `.provider-option[data-provider="custom"]`);

  for (const [selector, value] of [["#base-url", model.baseUrl], ["#api-key", "local-demo-no-secret"], ["#model-id", "demo-model"]]) {
    await rp.evaluate(settings, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center' }); el.focus(); el.select?.(); return true; })()`);
    await rp.typeText(settings, value);
  }

  await rp.evaluate(settings, `document.querySelector('#model-save').scrollIntoView({ block: 'center' }); true`);
  await rp.click(settings, "#model-save");
  await until(async () => String(await rp!.evaluate(settings, `document.querySelector('#model-status').textContent`)).startsWith("已保存") || undefined, 10_000, "模型保存");
  await rp.cdp.send("Target.closeTarget", { targetId: settingsTarget.targetId });
  await sleep(600);

  // 入口与浮层都走真实点击：原生 header popover 不能盖住模型搜索。
  await rp.click(panel, "#header-more");
  // SAFETY: 页面脚本返回的对象字段与下面的类型一一对应。
  const modelEntry = await rp.evaluate(panel, `(() => { const b = document.querySelector('#model-btn'); return { inHeaderMenu: !!document.querySelector('#header-menu #model-btn'), inComposer: !!document.querySelector('#composer #model-btn'), visible: !!b && !b.hidden && b.getClientRects().length > 0, label: b?.innerText ?? '' }; })()`) as { inHeaderMenu: boolean; inComposer: boolean; visible: boolean; label: string };
  check("当前模型入口在更多菜单内", modelEntry.inHeaderMenu && !modelEntry.inComposer && modelEntry.visible, modelEntry);

  if (modelEntry.visible) {
    await rp.click(panel, "#model-btn");
    await sleep(350);

    // SAFETY: 页面脚本返回 null 或下面这个字段固定的对象。
    const modelSearch = await rp.evaluate(panel, `(() => {
      const p = document.querySelector('#model-popover'); const input = p?.querySelector('.model-search-input');
      if (!p || !input) return null;
      const r = input.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { open: !p.hidden, searchVisible: input.getClientRects().length > 0, searchHit: hit === input || input.contains(hit), menuOpen: document.querySelector('#header-menu')?.matches(':popover-open') ?? false };
    })()`) as { open: boolean; searchVisible: boolean; searchHit: boolean; menuOpen: boolean } | null;

    check("点当前模型后搜索列表可见且能点到", !!modelSearch?.open && !!modelSearch.searchVisible && !!modelSearch.searchHit, modelSearch);
    await shot("0-model-open", 400);
    await until(async () => (await rp!.evaluate(panel, `document.activeElement?.classList.contains('model-search-input')`)) || undefined, 5_000, "模型搜索获得焦点");
    const escape = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...escape }, panel);
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...escape }, panel);
    await until(async () => (await rp!.evaluate(panel, `document.querySelector('#model-popover').hidden`)) || undefined, 5_000, "Escape 收起模型列表");
    const escapeFocus = String(await rp.evaluate(panel, `document.activeElement?.id ?? ''`));
    check("Escape 收起模型列表后焦点回更多", escapeFocus === "header-more", { activeElement: escapeFocus });

    await rp.click(panel, "#header-more");
    await rp.click(panel, "#model-btn");
    const currentModel = String(await rp.evaluate(panel, `document.querySelector('#model-popover .model-item.current')?.getAttribute('data-model') ?? ''`));

    if (currentModel) {
      await rp.click(panel, "#model-popover .model-item.current");
      // SAFETY: 页面表达式固定返回 closed 与 focus 两个字段。
      const selection = await rp.evaluate(panel, `({ closed: document.querySelector('#model-popover').hidden, focus: document.activeElement?.id ?? '' })`) as { closed: boolean; focus: string };
      check("点当前模型收起列表后焦点回更多", selection.closed && selection.focus === "header-more", { model: currentModel, ...selection });
    }

    await rp.click(panel, "#input");
  } else {
    check("点当前模型后搜索列表可见且能点到", false, { reason: "模型入口不可见" });
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
  const point = await shadowRead(`(() => {const r=this.querySelector('[data-act="handoff"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await rp.cdp.send("Input.dispatchMouseEvent", { type:"mousePressed", ...point, button:"left", clickCount:1 }, work);
  await rp.cdp.send("Input.dispatchMouseEvent", { type:"mouseReleased", ...point, button:"left", clickCount:1 }, work);
  await until(async () => await rp!.evaluate(panel, `!document.querySelector('#ask-cite').hidden`) || undefined, 5000, "选区转入引用");
  const cite = await rp.evaluate(panel, `({ text:document.querySelector('#ask-cite-text').textContent, host:document.querySelector('#ask-cite-host').textContent, focus:document.activeElement.id })`);
  check("划词转入保留原文、站点和输入焦点且不发模型请求", cite.text === "米娅负责编辑。" && cite.host.startsWith('127.0.0.1') && cite.focus === 'input' && model.requests.length === 0, cite);
  await rp.typeText(panel, "引用草稿");
  await rp.screenshot(panel, join(artifacts, "selection-cite.png"));
  await rp.click(panel, "#ask-cite-close");
  check("去掉引用不清空正文", await rp.evaluate(panel, `document.querySelector('#ask-cite').hidden && document.querySelector('#input').value === '引用草稿'`), null);
  await rp.evaluate(panel, `document.querySelector('#input').value='';document.querySelector('#input').dispatchEvent(new Event('input',{bubbles:true}));`);
  await rp.detach(worker);

  const idle = await shot("1-idle", 400);
  check("当前页引用在输入框内", idle.pageInComposer, { pagePill: idle.pagePill, composer: idle.composer });
  check("开始建议可见", idle.starterShown, { shown: idle.starterShown });
  const suggestion = String(await rp.evaluate(panel, `document.querySelector('#starter button[data-starter]')?.dataset.starter ?? ''`));
  await rp.click(panel, "#starter button[data-starter]");
  const draft = await read();
  check("开始建议只填草稿", !!suggestion && draft.input === suggestion && model.requests.length === 0, { input: draft.input, modelRequests: model.requests.length });
  await rp.click(panel, "#conversation-new");
  await until(async () => (await read()).input === "" || undefined, 10_000, "新会话草稿为空");
  check("新会话不继承上一段草稿", (await read()).input === "", { input: (await read()).input });

  await rp.click(panel, "#input");
  await rp.typeText(panel, "请在当前页找米娅");
  await rp.pressEnter(panel);
  await until(async () => model.requests.some((r) => r.rule === "找米娅") || undefined, 30_000, "真实发送抵达脚本模型");
  const running = await shot("2-running", 400);
  const taskCard = await rp.evaluate(panel, `(() => { const card = document.querySelector('.ai-task-card'); return { goal:card?.querySelector('.task-goal-line')?.textContent, expanded:card?.classList.contains('expanded') }; })()`);
  check("真实运行生成流式任务卡", taskCard.goal === "请在当前页找米娅", taskCard);

  if (taskCard.goal) {
    await rp.click(panel, ".ai-task-trigger");
    await sleep(240);
    const folded = await rp.evaluate(panel, `(() => {const c=document.querySelector(".ai-task-card");return {height:c.querySelector(".ai-task-reveal").getBoundingClientRect().height,inert:c.querySelector(".ai-task-reveal").inert,chevron:getComputedStyle(c.querySelector(".task-chevron")).transform};})()`);
    check("折叠后抽屉高度为零且不可聚焦", folded.height === 0 && folded.inert, folded);
    check("任务卡可折叠", await rp.evaluate(panel, `document.querySelector('.ai-task-trigger').getAttribute('aria-expanded') === 'false'`), null);
    await rp.click(panel, ".ai-task-trigger");
    await sleep(240);
    const craft = await rp.evaluate(panel, `(() => {const c=document.querySelector(".ai-task-card"), t=c.querySelector(".ai-task-trigger");return {outer:parseFloat(getComputedStyle(c).borderRadius),inner:parseFloat(getComputedStyle(t).borderRadius),padding:parseFloat(getComputedStyle(c).paddingLeft),height:c.querySelector(".ai-task-reveal").getBoundingClientRect().height,chevron:getComputedStyle(c.querySelector(".task-chevron")).transform};})()`);
    check("展开有真实高度、箭头转180度且圆角同心", craft.height > 0 && craft.chevron === "matrix(-1, 0, 0, -1, 0, 0)" && craft.outer === craft.inner + craft.padding, craft);
    await rp.cdp.send("Emulation.setEmulatedMedia", {features:[{name:"prefers-reduced-motion",value:"reduce"}]}, panel);
    check("减少动态效果关闭任务卡入场与抽屉过渡", await rp.evaluate(panel, `getComputedStyle(document.querySelector(".ai-task-card")).animationName === "none" && getComputedStyle(document.querySelector(".ai-task-reveal")).transitionDuration === "0s"`), null);
    await rp.cdp.send("Emulation.setEmulatedMedia", {features:[]}, panel);
    check("任务卡可再次展开", await rp.evaluate(panel, `document.querySelector('.ai-task-trigger').getAttribute('aria-expanded') === 'true'`), null);
  }

  check("运行中仍可输入补充", running.sendStopping && !(await rp.evaluate(panel, `document.querySelector('#input').disabled`)), { sendStopping: running.sendStopping });
  await until(async () => (await read()).answerText?.includes(reply.split("\n")[0]!) || undefined, 60_000, "回答落入真实侧栏");
  await until(async () => !!(await read()).actions || undefined, 15_000, "回答操作出现");

  // 与本任务的红基线实测读数成对校准：sans-serif 是系统字体回退项，不应误判为 serif 阅读档。
  const baselineReading = { answerFont: '"Songti SC", STSong, "Songti TC", SimSun, serif', answerSize: 15, answerLineHeight: 27 };
  const currentReading = await read();
  check("阅读判据校准：系统栈通过、红基线宋体失败", systemReading(currentReading) && !systemReading(baselineReading), { current: { font: currentReading.answerFont, size: currentReading.answerSize, lineHeight: currentReading.answerLineHeight }, baseline: baselineReading });

  for (const width of [360, 400, 440]) {
    const done = await shot("3-done", width);
    check(`${width}px 无横向溢出`, done.documentWidth <= width + 1 && done.overflow.length === 0, { documentWidth: done.documentWidth, overflow: done.overflow });
    check(`${width}px 回答为系统字体 15px、约 26px 行高`, systemReading(done), { font: done.answerFont, size: done.answerSize, lineHeight: done.answerLineHeight });
    check(`${width}px 复制操作可见且紧凑`, !!done.actions && done.actions.opacity >= 0.9 && done.actions.rect.height <= 30 && done.actions.button === "复制回答" && !!done.actions.buttonRect && done.actions.buttonRect.width <= 32, done.actions);
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
