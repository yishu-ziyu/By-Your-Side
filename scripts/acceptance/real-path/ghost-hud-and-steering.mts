/**
 * 直连按钮与改方向（docs/evals/20261005-ghost-hud-and-steering.md R1–R4）：只装扩展的隔离无头 Chrome、真侧栏、
 * 本机网页与本机脚本模型。按钮必须不经模型；改方向必须截断正在写的长文、同一轮换成新回答。
 *
 *   npx tsx scripts/acceptance/real-path/ghost-hud-and-steering.mts --headless --run=final
 *
 * --run= 只决定证据目录 out/acceptance/ghost-hud-and-steering/<run>/：不写时是 candidate（候选轮），最终验收用 final。
 */
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, REPO, siteAddress, until, sleep, type Json } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();

const run = process.argv.find(arg => arg.startsWith('--run='))?.slice(6) ?? 'candidate';

if (!/^[a-z0-9-]+$/.test(run)) throw Error('invalid run');

const out = join(REPO, 'out/acceptance/ghost-hud-and-steering', run);

await mkdir(out, { recursive: true });

// 10 秒静音 WAV：真媒体元素，能播能停。
const wav = (() => { const rate = 8000, n = rate * 10, b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);

 return b; })();

const pages = new Map(Object.entries({
  '/media': '<title>媒体页</title><audio id="m" src="/tone.wav" controls loop></audio><button class="ytp-next-button" onclick="window.nextClicks=(window.nextClicks||0)+1">下一个</button><a href="#more">Next page</a>',
  '/docs': `<title>文档页</title><p>Gateway API Specification</p><pre id="code">${Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')}</pre>`,
  '/plain': '<title>普通页</title><p>没有媒体也没有代码。</p><a href="#n">Next</a>',
}));

const site = createServer((q, r) => q.url === '/tone.wav' ? r.writeHead(200, { 'content-type': 'audio/wav' }).end(wav) : r.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end(`<!doctype html><meta charset="utf-8">${pages.get(q.url ?? '') ?? pages.get('/plain')}`));

await new Promise<void>(r => site.listen(0, '127.0.0.1', r));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const HEAD = '正在逐段梳理两者差异。1. Ingress 采用集中单体定义，应用层与网络层权限容易混淆。';

const TAIL = '最后一句：注解滥用导致跨厂商迁移极其痛苦。';

const LONG = HEAD + '2. 扩展方式依赖厂商注解。'.repeat(12) + TAIL;

const TABLE = '| 维度 | Ingress | Gateway API |\n|---|---|---|\n| 角色模型 | 单体集中 | 分权解耦 |\n| 跨命名空间 | 不支持 | 原生支持 |';

const payloads: string[] = [];

const model = await startScriptedModel([
  { match: '改成对比表格', steps: [{ text: TABLE }] },
  { match: '对比 Ingress', steps: [{ text: LONG, chunkDelayMs: 200 }] },
], undefined, payload => { if (payload.tools?.length) payloads.push(JSON.stringify(payload.messages)); });

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  const go = async (path: string) => { await rp.cdp.send('Page.navigate', { url: origin + path }, work); await until(async () => await rp.evaluate(work, `location.pathname===${JSON.stringify(path)} && !!document.querySelector("[data-sideagent-ask]")`), 10000, `content script ${path}`); };

  await go('/media');
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false'), 60000, 'panel ready');

  // ── R1/R2 直连按钮 ──
  await rp.evaluate(work, 'document.querySelector("#m").play().then(()=>true)', { userGesture: true });
  check('媒体开始播放', await rp.evaluate(work, '!document.querySelector("#m").paused'), null);
  const bar = await until(async () => await rp.evaluate(panel, '(()=>{const b=document.querySelector("#ghost-bar");return b&&!b.hidden?[...b.querySelectorAll(".ghost-action")].map(x=>x.dataset.action):null})()'), 10000, 'ghost bar');
  check('媒体页出现暂停与下一个，没有乱认的 Next 链接', JSON.stringify(bar) === JSON.stringify(['toggle_play', 'next']), bar);
  const before = model.requests.length;
  await rp.click(panel, '.ghost-action[data-action="toggle_play"]');
  await sleep(150);
  const hudShown = await rp.evaluate(work, '[...document.querySelectorAll("[data-bys-ghost-hud]")].map(h=>h.shadowRoot.querySelector("[role=status]").textContent)');
  await rp.screenshot(work, join(out, 'hud.png'));
  const paused = await rp.evaluate(work, 'document.querySelector("#m").paused');
  const elapsed = Number(await rp.evaluate(panel, 'document.querySelector("#ghost-bar").dataset.lastElapsedMs'));
  check('点暂停后媒体暂停', paused === true, paused);
  check('从点到做完 ≤50ms', elapsed <= 50, elapsed);
  check('页面正中出现提示且说明结果', hudShown.length === 1 && String(hudShown[0]).includes('已暂停'), hudShown);
  check('侧栏读数说明没用模型', String(await rp.evaluate(panel, 'document.querySelector(".ghost-timing").textContent')).includes('没用模型'), await rp.evaluate(panel, 'document.querySelector(".ghost-timing").textContent'));
  await rp.screenshot(panel, join(out, 'ghost-bar.png'));
  await sleep(1400);
  check('1.2 秒后提示删除不留节点', await rp.evaluate(work, 'document.querySelectorAll("[data-bys-ghost-hud]").length===0'), null);
  await rp.click(panel, '.ghost-action[data-action="next"]');
  await rp.click(panel, '.ghost-action[data-action="next"]');
  await sleep(100);
  const nextClicks = await rp.evaluate(work, 'window.nextClicks');
  const huds = await rp.evaluate(work, 'document.querySelectorAll("[data-bys-ghost-hud]").length');
  check('点两次下一个，播放器按钮被按两次', nextClicks === 2, nextClicks);
  check('连点只留一个提示', huds === 1, huds);
  check('按钮不调用模型', model.requests.length === before, model.requests.length - before);

  await go('/docs');
  await until(async () => await rp.evaluate(panel, '!!document.querySelector(".ghost-action[data-action=toggle_code]")'), 10000, 'code button');
  await rp.click(panel, '.ghost-action[data-action="toggle_code"]');
  await sleep(100);
  const folded = await rp.evaluate(work, 'document.querySelector("#code").getBoundingClientRect().height');
  check('长代码块折叠到 120px 内', folded <= 121, folded);
  await until(async () => await rp.evaluate(panel, 'document.querySelector(".ghost-action[data-action=toggle_code]")?.textContent.includes("展开")'), 3000, 'label');
  await rp.click(panel, '.ghost-action[data-action="toggle_code"]');
  await sleep(100);
  check('再点展开', await rp.evaluate(work, 'document.querySelector("#code").getBoundingClientRect().height') > 300, null);
  await go('/plain');
  await sleep(2200);
  check('没有可做动作的页面不出按钮', await rp.evaluate(panel, 'document.querySelector("#ghost-bar").hidden'), null);

  // ── R3/R4 改方向 ──
  await rp.click(panel, '#header-more'); await rp.click(panel, '#model-settings-open');
  const settings = await rp.attach((await until(async () => (await rp.targets()).find(t => t.url.endsWith('/settings.html')), 10000, 'settings')).targetId);
  await until(async () => await rp.evaluate(settings, 'document.querySelectorAll(".provider-option").length>3'), 10000, 'providers');
  await rp.evaluate(settings, 'document.querySelector("#provider-more").open=true');
  await rp.click(settings, '.provider-option[data-provider="custom"]');

  for (const [selector, value] of [['#base-url', model.baseUrl], ['#api-key', 'local-fixture'], ['#model-id', 'fixture']]) {
    await rp.evaluate(settings, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView();e.focus();e.select()})()`); await rp.typeText(settings, value);
  }

  await rp.evaluate(settings, 'document.querySelector("#model-save").scrollIntoView()'); await rp.click(settings, '#model-save');
  await until(async () => String(await rp.evaluate(settings, 'document.querySelector("#model-status").textContent')).startsWith('已保存'), 10000, 'saved');
  await rp.cdp.send('Target.closeTarget', { targetId: (await rp.targets()).find(t => t.url.endsWith('/settings.html'))!.targetId });
  // 输入框改版（docs/evals/20261006-composer-quiet.md）去掉了运行中的「改方向」建议按钮：改方向就是在输入框里直接说。
  check('空闲时不显示改方向提示区', await rp.evaluate(panel, '!document.querySelector("#steer-ribbon")?.getClientRects().length'), null);
  await rp.click(panel, '#input'); await rp.typeText(panel, '对比 Ingress 和 Gateway API'); await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn").classList.contains("stopping") && (document.querySelector(".msg.assistant.streaming")?.textContent.length ?? 0) > 20'), 20000, '长文写到一半');
  await rp.screenshot(panel, join(out, 'steer-before.png'));
  await rp.click(panel, '#input'); await rp.typeText(panel, '把正在写的回答改成对比表格。');
  const clickedAt = Date.now();
  await rp.click(panel, '#steer-send-btn');
  await until(async () => await rp.evaluate(panel, '!!document.querySelector(".answer-actions") && !document.querySelector("#send-btn").classList.contains("stopping")'), 20000, '新回答写完');
  await sleep(600);
  await rp.screenshot(panel, join(out, 'steer-after.png'));
  const second = model.requests.find(r => r.rule === '改成对比表格');
    // 长文还剩约 3 秒没写；新回答在点完 1.5 秒内出字，说明没等长文写完。
  check('改方向后立刻按新要求写（不等长文写完）', !!second?.firstTextAt && second.firstTextAt - clickedAt < 1500, { afterClickMs: second?.firstTextAt ? second.firstTextAt - clickedAt : null });
  // SAFETY: payloads 是本脚本的假模型收到的 OpenAI 风格请求体，messages 的 content 要么是字符串，要么是带 text 的分段数组。
  const steered = JSON.parse(payloads.find(p => p.includes('把正在写的回答改成对比表格')) ?? '[]') as Array<{ role: string; content?: string | Array<{ text?: string }> }>;
  const text = (m?: { content?: string | Array<{ text?: string }> }) => Array.isArray(m?.content) ? m.content.map(p => p.text ?? '').join('') : m?.content ?? '';
  const half = text(steered.filter(m => m.role === 'assistant').at(-1));
  const steerAt = steered.findIndex(m => m.role === 'user' && text(m).includes('把正在写的回答改成对比表格'));
  check('新请求带原半截正文（长文前缀、没写完）和改方向原话', half.length > 0 && LONG.startsWith(half) && half.length < LONG.length && steerAt > steered.findIndex(m => m.role === 'assistant'), { half: half.length, total: LONG.length, steerAt });
  const view = await rp.evaluate(panel, '({table:!!document.querySelector(".msg.assistant table"),tag:document.querySelector(".steer-tag")?.textContent??null,errors:[...document.querySelectorAll(".msg.error")].map(e=>e.textContent),tail:document.querySelector("#messages").textContent.includes(' + JSON.stringify(TAIL) + '),answers:document.querySelectorAll(".answer-actions").length,users:[...document.querySelectorAll(".msg.user")].map(u=>u.textContent)})');
  check('回答换成表格并挂改方向标记', view.table && view.tag === '⚡ 已改方向：改成对比表格', view);
  check('不出错误、原长文末句没写出来', view.errors.length === 0 && !view.tail, view);
  const mainRequests = model.requests.filter(r => r.tools).map(r => r.rule);
  check('同一轮：主模型只调两次（被截断的一次 + 重写），只有一个最终回答，历史里有改方向原话', JSON.stringify(mainRequests) === JSON.stringify(['对比 Ingress', '改成对比表格']) && view.answers === 1 && view.users.some((u: string) => u.includes('改成对比表格')), { mainRequests, answers: view.answers });
  await rp.cdp.send('Page.reload', {}, panel);
  await until(async () => await rp.evaluate(panel, '!!document.querySelector(".msg.assistant table")'), 20000, 'history');
  const replay = await rp.evaluate(panel, '({tag:document.querySelector(".steer-tag")?.textContent??null,users:[...document.querySelectorAll(".msg.user")].map(u=>u.textContent).length,conversations:document.querySelector("#conversation-switcher").textContent})');
  check('重开侧栏后历史保留改方向与表格', replay.tag === '⚡ 已改方向：改成对比表格' && replay.users === 2, replay);
} catch (error) { check('流程完成', false, String(error)); } finally {
  await writeFile(join(out, 'result.json'), JSON.stringify({ checks, notCovered: ['真实 YouTube/Bilibili 页面', '供应商模型改写质量', '动效手感（人看）'], modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(r => site.close(() => r()));
}

if (checks.some(c => !c.pass)) process.exitCode = 1;
