/**
 * 助手连做几步时，光标像人手：做完一步停在原处，下一步从那里直接飞过去，不先回右下角；
 * 点了链接换页，新网页的光标从同一个点出现；一轮结束回右下角待命；去了别的标签页，原页上的光标不留在页面中间。
 * 只装扩展、隔离构建、本机脚本模型、本机练习站；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/cursor-stay-put.mts --headless
 * 第一轮：A 页左上「第一步」→ 右上「第二步」→ 中间链接「去下一页」（换到 B 页）→ B 页「第三步」→ 说一句话。
 * 第二轮：再点一次「第三步」→ 新开一个标签页读一次 → 说一句话。
 * 每步之间模型想 3.5 秒（比名牌停留加淡出更久），每 40 毫秒记一次原标签页上的光标位置，同时录下 A、B 两页。
 * 判据：第一轮从停到「第一步」起到说完话，光标从没进过右下角待命点 80px 内、从没处于待命；
 * 光标依次停在第一步、第二步、（B 页）接过来的点、第三步上（点了链接页面马上跳走，链接上停多久不算），
 * 每段飞行都贴着前后两个停点之间的连线；B 页上第一次看到的光标就在 A 页最后停的点上，那个点在链接上；
 * 第一轮说完话后 6 秒内回到右下角待命；第二轮光标先停在「第三步」上，助手去了新标签页后 3 秒内，
 * B 页的光标收起或回右下角（不留在页面中间），这一轮结束后也一样。
 * 失败方式：做完一步就回右下角（改动前的扩展），前四条都失败。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-cursor-stay-put`);

await mkdir(out, { recursive: true });

const button = (id: string, text: string, left: number, top: number) =>
  `<button id="${id}" style="position:absolute;left:${left}px;top:${top}px;width:150px;height:46px" onclick="this.textContent='已点：${text}'">${text}</button>`;
const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{margin:0;font:16px/1.5 -apple-system,sans-serif;background:#f6f5f1}button,a{font:inherit}</style><h1 style="margin:24px">${title}</h1>${body}`;
const PAGES: Record<string, string> = {
  "/a": page("练习页 A", button("one", "第一步", 90, 120) + button("two", "第二步", 760, 170) +
    '<a id="go" href="/b" style="position:absolute;left:420px;top:430px;display:block;width:150px;height:46px;line-height:46px;text-align:center;background:#e8eefc">去下一页</a>'),
  "/b": page("练习页 B", button("three", "第三步", 860, 330)),
  "/c": page("练习页 C", "<p>另一个标签页。</p>"),
};
const site = createServer((q, r) => {
  const html = PAGES[q.url ?? ""];

  if (!html) return void r.writeHead(404).end();
  r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(html);
});
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const GOAL = "按顺序点三步";
const GOAL2 = "再点一次第三步，然后开个新标签页";
const THINK_MS = 3500;
const click = (target: string) => ({ tool: { name: "click", args: { target } }, delayMs: THINK_MS });
const model = await startScriptedModel([{ match: GOAL, steps: [
  { tool: { name: "tabs", args: { action: "active" } } },
  { tool: { name: "snapshot", args: {} } },
  { tool: { name: "click", args: { target: "#one" } } },
  click("#two"),
  click("#go"),
  click("#three"),
  { text: "三步都点完了。", delayMs: THINK_MS },
] }, { match: GOAL2, steps: [
  { tool: { name: "click", args: { target: "#three" } } },
  { tool: { name: "tabs", args: { action: "open", url: `${origin}/c` } }, delayMs: THINK_MS },
  { tool: { name: "snapshot", args: {} } },
  { text: "新标签页开好了。", delayMs: THINK_MS },
] }]);
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => {
  checks.push({ name, pass, actual });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual));
};

type Pt = { x: number; y: number };
type Box = { left: number; top: number; right: number; bottom: number };
type Sample = { t: number; path: string; x: number; y: number; resting: boolean; hidden: boolean; vw: number; vh: number };
type Dwell = Pt & { path: string; from: number; to: number };
const samples: Sample[] = [];
const near = (a: Pt, b: Pt, px: number) => Math.hypot(a.x - b.x, a.y - b.y) <= px;
const inside = (p: Pt, b: Box) => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;
const homeOf = (s: Sample): Pt => ({ x: Math.max(28, s.vw - 41), y: Math.max(48, s.vh - 102) });

/** 点到线段的距离：飞行是一侧的浅弧加轻微过冲，贴着两点连线走。 */
function offLine(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));

  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 光标在同一页同一点停了至少 400ms 的地方：点击前后的停顿。 */
function dwells(list: Sample[]): Array<Dwell & { first: number; last: number }> {
  const found: Array<Dwell & { first: number; last: number }> = [];
  let start = 0;

  for (let i = 1; i <= list.length; i++) {
    const head = list[start]!;
    const s = list[i];

    if (s && s.path === head.path && near(s, head, 1)) continue;
    const tail = list[i - 1]!;

    if (tail.t - head.t >= 400) found.push({ x: head.x, y: head.y, path: head.path, from: head.t, to: tail.t, first: start, last: i - 1 });
    start = i;
  }

  return found;
}

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `${origin}/a` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, "document.querySelector(\"#conversation-new\")?.disabled===false && document.querySelector(\"#send-btn\")?.disabled===false"), 60_000, "侧栏就绪");
  const tabId = Number(await rp.evaluate(panel, `chrome.tabs.query({}).then(ts => ts.find(t => t.url?.startsWith(${JSON.stringify(origin)}))?.id ?? null)`));
  // 光标挂在封闭的 shadow root 里，只有内容脚本那一侧读得到它的位置。
  const read = async (): Promise<Sample | null> => {
    try {
      const s = await rp.evaluate(panel, `chrome.scripting.executeScript({target:{tabId:${tabId}},world:"ISOLATED",func:()=>{const c=window.__sideagent?.cursorState?.();return c?{path:location.pathname,x:c.x,y:c.y,resting:c.resting,hidden:c.hidden,vw:innerWidth,vh:innerHeight}:null}}).then(rs=>rs[0]?.result??null,()=>null)`) as Omit<Sample, "t"> | null;

      return s ? { t: Date.now(), ...s } : null;
    } catch {
      return null;
    }
  };
  await until(async () => (await read())?.resting || undefined, 15_000, "A 页的光标在角落待命");
  // 点击会把目标滚进视野，所以在点完之后量框（练习页本身不需要竖向滚动）。
  const boxes = async (ids: string[]) => await rp.evaluate(work, `Object.fromEntries(${JSON.stringify(ids)}.map(id => { const r = document.getElementById(id).getBoundingClientRect(); return [id, { left: r.left, top: r.top, right: r.right, bottom: r.bottom }]; }))`) as Record<string, Box>;
  const onA = await boxes(["one", "two", "go"]);
  await rp.screenshot(work, join(out, "page-a.png"));

  const stopVideo = await recordScreen(rp.cdp, work, join(out, "cursor.mp4"));
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const s = await read();

      if (s) samples.push(s);
      await sleep(40);
    }
  })();

  await rp.click(panel, "#input");
  await rp.typeText(panel, GOAL);
  await rp.pressEnter(panel);
  await until(async () => String(await rp.evaluate(work, "document.querySelector('#three')?.textContent ?? ''")).startsWith("已点") || undefined, 90_000, "助手点完第三步");
  const onB = await boxes(["three"]);
  const clickedThreeAt = Date.now();
  await sleep(600);
  await rp.screenshot(work, join(out, "page-b-after-clicks.png"));
  // 放大 4 倍看箭头本身的形状。截图的裁剪框按整页坐标算，点击时页面横向滚过。
  const tip = samples.at(-1)!;
  const [sx, sy] = await rp.evaluate(work, "[scrollX, scrollY]") as [number, number];
  const zoom = await rp.cdp.send("Page.captureScreenshot", { format: "png", clip: { x: tip.x + sx - 16, y: tip.y + sy - 16, width: 48, height: 48, scale: 5 } }, work) as { data: string };
  await writeFile(join(out, "cursor-zoom.png"), Buffer.from(zoom.data, "base64"));
  await until(async () => (await rp.evaluate(panel, "document.body.innerText.includes('三步都点完了')")) || undefined, 30_000, "模型说完话");
  const turnEndAt = Date.now();
  const outOfTheWay = (s: Sample) => s.hidden || (s.resting && near(s, homeOf(s), 3));
  const parkedAt = await until(async () => {
    const s = samples.at(-1);

    return s && s.t > turnEndAt && s.resting && near(s, homeOf(s), 3) ? s.t : undefined;
  }, 8_000, "第一轮结束后回到角落").catch(() => null);

  await until(async () => await rp.evaluate(panel, "document.querySelector(\"#send-btn\")?.disabled===false") || undefined, 30_000, "侧栏可发送");
  await rp.click(panel, "#input");
  await rp.typeText(panel, GOAL2);
  await rp.pressEnter(panel);
  const goal2At = Date.now();
  await until(async () => (await rp.targets()).some((t) => t.url === `${origin}/c`) || undefined, 30_000, "助手新开标签页");
  const leftAt = Date.now();
  await until(async () => (await rp.evaluate(panel, "document.body.innerText.includes('新标签页开好了')")) || undefined, 30_000, "第二轮说完话");
  const turn2EndAt = Date.now();
  await sleep(3000);
  sampling = false;
  await sampler;
  const video = await stopVideo();

  const visible = samples.filter((s) => !s.hidden);
  const firstAtOne = visible.findIndex((s) => s.path === "/a" && inside(s, onA.one!));
  const working = visible.slice(Math.max(0, firstAtOne)).filter((s) => s.t <= turnEndAt);
  const wentHome = working.filter((s) => s.resting || near(s, homeOf(s), 80));
  check("第一轮从停到第一步起到说完话，光标没回过右下角、没进入待命", firstAtOne >= 0 && wentHome.length === 0,
    { samples: working.length, firstAtOne, wentHome: wentHome.slice(0, 3).map(({ t, path, x, y, resting }) => ({ t, path, x, y, resting })) });

  const lastOnA = [...working].reverse().find((s) => s.path === "/a");
  const firstOnB = visible.find((s) => s.path === "/b");
  const stops = dwells(working).filter((d) => !(d.path === "/a" && inside(d, onA.go!)));
  const expected: Array<[string, Box]> = [["/a", onA.one!], ["/a", onA.two!], ["/b", onA.go!], ["/b", onB.three!]];
  const stopped = stops.length === expected.length && expected.every(([path, box], i) => stops[i]!.path === path && inside(stops[i]!, box));
  check("光标依次停在第一步、第二步、（B 页）接过来的点、第三步", stopped,
    stops.map(({ path, x, y, from, to }) => ({ path, x, y, ms: to - from })));

  const leg = (from: number, to: number) => {
    const flight = working.slice(from, to + 1);
    const a = working[from]!;
    const b = working[to]!;

    return { from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y }, points: flight.length, maxOff: Math.round(Math.max(...flight.map((s) => offLine(s, a, b)))) };
  };
  const legs = stopped && lastOnA ? [leg(stops[0]!.last, stops[1]!.first), leg(stops[1]!.last, working.indexOf(lastOnA)), leg(stops[2]!.last, stops[3]!.first)] : [];
  check("每段都从上一个停点直接飞到下一个停点（离两点连线不超过 50px）",
    legs.length === 3 && legs.every((leg) => leg.points >= 3 && leg.maxOff <= 50), legs);

  check("换到 B 页后，第一次看到的光标就在 A 页最后停的点上（链接上），不在角落",
    !!firstOnB && !!lastOnA && !firstOnB.resting && near(firstOnB, lastOnA, 2) && inside(lastOnA, onA.go!), { lastOnA: lastOnA ?? null, firstOnB: firstOnB ?? null });

  check("第一轮说完话后 6 秒内回到右下角待命", parkedAt !== null && parkedAt - turnEndAt <= 6000, { turnEndAt, parkedAt });

  // 去别的标签页时，原页通常换成右边缘「在另一页」的胶囊、光标收起；没换胶囊时，光标回角落待命。
  const outAtThree = samples.some((s) => s.path === "/b" && s.t > goal2At && s.t < leftAt && !s.hidden && !s.resting && inside(s, onB.three!));
  const away = samples.filter((s) => s.path === "/b" && s.t > leftAt + 3000);
  check("第二轮：光标先停在第三步上；助手去了别的标签页，3 秒内 B 页的光标收起或回右下角，不留在页面中间",
    outAtThree && away.length > 0 && away.every(outOfTheWay), { outAtThree, leftAt, turn2EndAt, first: away[0] ?? null, last: away.at(-1) ?? null });
  await writeFile(join(out, "trajectory.json"), JSON.stringify({ onA, onB, clickedThreeAt, turnEndAt, goal2At, leftAt, turn2EndAt, samples, video }, null, 2));
} catch (error) {
  check("流程完成", false, String(error));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every((c) => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  await new Promise<void>((done) => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some((c) => !c.pass)) process.exitCode = 1;
