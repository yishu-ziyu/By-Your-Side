/**
 * 工具栏淡出（docs/evals/20261005-chrome-quiet.md R1–R4）：只装扩展的隔离无头 Chrome、真侧栏，
 * 真实键盘、鼠标移动与滚轮；读顶栏和按钮的实际不透明度。不需要模型。
 *
 *   npx tsx scripts/acceptance/real-path/chrome-quiet.mts --headless --run=final
 *
 * --run= 只决定证据目录 out/acceptance/chrome-quiet/<run>/：不写时是 candidate（候选轮），最终验收用 final。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, REPO, until, sleep, type Json } from './harness.mts';

requireHeadless();

const run = process.argv.find(arg => arg.startsWith('--run='))?.slice(6) ?? 'candidate';

if (!/^[a-z0-9-]+$/.test(run)) throw Error('invalid run');

const out = join(REPO, 'out/acceptance/chrome-quiet', run);

await mkdir(out, { recursive: true });

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, JSON.stringify(actual)); };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#input") && document.querySelector("#topbar") && document.readyState==="complete"'), 30000, 'panel');
  await sleep(1000);

  const opacity = async (selector: string) => Number(await rp.evaluate(panel, `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).opacity`));
  const centre = (selector: string) => rp.evaluate(panel, `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  const move = (at: { x: number; y: number }) => rp.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'none' }, panel);

  const key = async (k: string, code: string, vk: number, text?: string) => {
    for (const type of ['keyDown', 'keyUp']) {
      const event = { type, key: k, code, windowsVirtualKeyCode: vk, text: type === 'keyDown' && text ? text : undefined };

      await rp.cdp.send('Input.dispatchKeyEvent', event, panel);
    }
  };

  const type = async (ms: number) => { const end = Date.now() + ms;

    while (Date.now() < end) { await key('a', 'KeyA', 65, 'a'); await sleep(90); } };

  const wheel = async (at: { x: number; y: number }) => rp.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...at, deltaX: 0, deltaY: 120 }, panel);

  /** 从现在起多久达到条件；最多等 ms。 */
  const timed = async (read: () => Promise<boolean>, ms: number) => { const at = Date.now();

    return until(async () => (await read()) || null, ms, 'wait', 20).then(() => Date.now() - at, () => null); };

  const faded = ['#conversation-switcher', '#conversation-new', '#header-more', '#page-pill', '#attach-btn'];
  const all = async () => Object.fromEntries(await Promise.all([...faded, '#status-pill', '#input', '#send-btn'].map(async s => [s, await opacity(s)])));
  const loud = async () => (await opacity('#header-more')) >= 0.95;

  // 对话区放一段很长的内容，让滚轮真的滚动（滚动后浏览器会补发一次不动的鼠标移动）。
  await rp.evaluate(panel, 'document.querySelector("#messages").insertAdjacentHTML("beforeend", "<div style=\\"height:3000px\\">长回答</div>")');
  const input = await centre('#input');
  const messages = await centre('#messages');
  const initial = await all();
  check('一开始顶栏按钮完全可见', await loud(), initial);
  await rp.click(panel, '#input');

  // ── R1 打字约 1 秒后变淡；只打一个字不淡 ──
  await type(300);
  await sleep(1500);
  check('打 0.3 秒就停下，1.5 秒后仍不淡', await loud(), await opacity('#header-more'));
  await type(1300); await sleep(500);
  const quiet = await all();
  check('连续打字后顶栏和次要按钮都变淡', faded.every(s => quiet[s]! < 0.2), quiet);
  check('变淡时状态、输入框和发送按钮不变', quiet['#status-pill'] === 1 && quiet['#input'] === 1 && quiet['#send-btn'] === 1, { status: quiet['#status-pill']!, input: quiet['#input']!, send: quiet['#send-btn']! });
  await rp.screenshot(panel, join(out, 'quiet.png'));

  // ── R2 鼠标一动就回来 ──
  const now = await centre('#input');
  await move({ x: now.x + 20, y: now.y - 4 });
  const backMs = await timed(loud, 1000);
  check('移动鼠标后 200ms 内恢复', backMs !== null && backMs <= 200, backMs);
  await sleep(300);
  const restored = await all();
  check('恢复后回到各自原来的样子（禁用按钮仍是半透明）', faded.every(f => restored[f] === initial[f]), { initial, restored });
  await rp.screenshot(panel, join(out, 'loud.png'));

  // ── R1 反例：指针停在顶栏上打字不淡 ──
  await move(await centre('#topbar'));
  await rp.evaluate(panel, 'document.querySelector("#input").focus()');
  await type(1300); await sleep(500);
  check('指针停在顶栏上打字不淡', await loud(), await opacity('#header-more'));

  // ── R1 滚轮读回答 ──
  await move(messages); await sleep(100);
  const scrolledBefore = Number(await rp.evaluate(panel, 'document.querySelector("#messages").scrollTop'));
  await wheel(messages); await sleep(600);
  const scrolled = Number(await rp.evaluate(panel, 'document.querySelector("#messages").scrollTop'));
  check('在对话区滚动后变淡', scrolled > scrolledBefore && (await opacity('#header-more')) < 0.2, { scrolledBefore, scrolled, opacity: await opacity('#header-more') });

  // ── R2 Tab 到按钮 ──
  await rp.evaluate(panel, 'document.querySelector("#input").focus()');
  await key('Tab', 'Tab', 9);
  const focused = String(await rp.evaluate(panel, 'document.activeElement?.id || document.activeElement?.tagName'));
  const tabMs = await timed(async () => Number(await rp.evaluate(panel, 'getComputedStyle(document.activeElement).opacity')) >= 0.95 && (await loud()), 1000);
  check('Tab 到按钮后按钮完全可见', tabMs !== null && tabMs <= 200, { focused, tabMs });

  // ── R3 菜单开着不淡 ──
  await rp.click(panel, '#header-more');
  await until(async () => await rp.evaluate(panel, '!!document.querySelector("#header-menu:popover-open")'), 3000, '菜单打开');
  // 焦点回到输入框（不点击，菜单保持开着），再打字：只靠「菜单开着」这一条挡住淡出。
  await rp.evaluate(panel, 'document.querySelector("#input").focus()');
  await move(messages); await type(1300); await sleep(300);
  check('菜单开着时打字，顶栏不淡', await loud() && !!(await rp.evaluate(panel, '!!document.querySelector("#header-menu:popover-open")')), { opacity: await opacity('#header-more'), active: await rp.evaluate(panel, 'document.activeElement?.id') });
  await key('Escape', 'Escape', 27);
  await until(async () => !(await rp.evaluate(panel, '!!document.querySelector("#header-menu:popover-open")')), 3000, '菜单关闭');

  // ── R4 减少动态效果：照样变淡，过渡为 0 ──
  await rp.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, panel);
  await move({ x: input.x, y: input.y }); await rp.evaluate(panel, 'document.querySelector("#input").focus()');
  await type(1300); await sleep(100);
  const reduced = { opacity: await opacity('#header-more'), duration: await rp.evaluate(panel, 'document.querySelector("#header-more").getAnimations().filter(a=>a instanceof CSSTransition===false).map(a=>a.effect.getTiming().duration)') };
  // SAFETY: duration 是页内表达式返回的每个动画 duration 数组，由上面的 evaluate 字符串决定。
  check('减少动态效果时直接变淡，没有过渡', reduced.opacity < 0.2 && (reduced.duration as number[]).length > 0 && (reduced.duration as number[]).every(d => d === 0), reduced);
  await move({ x: input.x + 30, y: input.y });
  await sleep(50);
  check('减少动态效果时直接恢复', await loud(), await opacity('#header-more'));
} catch (error) { check('流程完成', false, String(error)); } finally {
  await writeFile(join(out, 'result.json'), JSON.stringify({ checks, notCovered: ['真人观感', '触控板惯性滚动', '运行任务时的侧栏'] }, null, 2));
  await rp.close(); await rp.remove();
}

if (checks.some(c => !c.pass)) process.exitCode = 1;
