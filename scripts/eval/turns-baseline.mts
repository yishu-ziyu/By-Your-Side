/**
 * 三种转折的读数（不是验收）：答完补一句、做到一半改方向、做到一半补信息（docs/evals/20261011-turns-baseline.md）。
 *   npx tsx scripts/eval/turns-baseline.mts --headless [--model=provider/id] [--repeat=N] [--only=follow,redirect,addinfo]
 * 本机练习站：会议室一览、预订表单、我的预订（可取消）、5 款笔记本的列表和详情页；服务器记下每次预订、取消和页面访问。
 * 每题一个新会话。插话的时机由服务器触发：助手第一次打开预订表单或某个笔记本详情页时，像用户一样在侧栏打字回车。
 * 读数取自诊断记录和服务器：你说完到助手收到（听到）、到下一段正文出字、到做完，插话之后旧方向又做了几步，最后对不对。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until } from "../acceptance/real-path/harness.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "../acceptance/real-path/inproc-config.mts";

requireHeadless();

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const modelId = arg("model") ?? DEFAULT_TEST_MODEL;

const repeat = Number(arg("repeat") ?? 1);

const only = arg("only")?.split(",");

const out = join(REPO, "out/eval/turns", new Date().toISOString().replace(/[:.]/g, "-"));

await mkdir(out, { recursive: true });

// 会议室：12 日 15:00 够 8 人又带投影仪的只有金桂（排在最后）；红枫那时已被订。
const ROOMS = [
  { name: "青松", cap: 10, projector: false }, { name: "白桦", cap: 6, projector: true },
  { name: "红枫", cap: 12, projector: true, taken: "10 月 12 日 15:00" }, { name: "银杏", cap: 8, projector: false }, { name: "金桂", cap: 9, projector: true },
];

// 笔记本：最轻的是 D（8999 元），6000 元以下最轻的是 E。列表页不写重量，要进详情页看。
const LAPTOPS = [
  { id: "a", name: "青羽 A14", price: 4999, kg: 1.6 }, { id: "b", name: "云帆 B13", price: 6999, kg: 1.1 }, { id: "c", name: "星河 C14", price: 5599, kg: 1.3 },
  { id: "d", name: "极光 D13", price: 8999, kg: 0.98 }, { id: "e", name: "晨风 E13", price: 5899, kg: 1.25 },
];

type Booking = { id: number; date: string; time: string; room: string; topic: string; cancelled: boolean; at: number };

let bookings: Booking[] = [];

let hits: Array<{ path: string; at: number }> = [];

const html = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:15px system-ui;margin:28px;max-width:760px} td,th{padding:4px 10px;border-bottom:1px solid #ddd;text-align:left} label{display:block;margin:10px 0} #ok{color:green}</style><h1>${title}</h1>${body}`;

const pages: Record<string, () => string> = {
  "/rooms": () => html("会议室一览", `<table><tr><th>会议室</th><th>人数</th><th>投影仪</th><th>备注</th></tr>${ROOMS.map(r => `<tr><td>${r.name}</td><td>${r.cap} 人</td><td>${r.projector ? "有" : "无"}</td><td>${r.taken ? `${r.taken} 已被订` : ""}</td></tr>`).join("")}</table><p><a href="/book">去预订</a> · <a href="/mine">我的预订</a></p>`),
  "/book": () => html("预订会议室", `<label>日期 <select id="date"><option value="">选择日期</option><option>10 月 12 日</option><option>10 月 13 日</option></select></label>
<label>时间 <select id="time"><option value="">选择时间</option><option>14:00</option><option>15:00</option><option>16:00</option></select></label>
<label>会议室 <select id="room"><option value="">选择会议室</option>${ROOMS.map(r => `<option>${r.name}</option>`).join("")}</select></label>
<label>主题 <input id="topic"></label><button id="go" type="button" onclick="book()">预订</button> <span id="ok" role="status"></span> <a href="/mine">我的预订</a>
<script>async function book(){const d={date:date.value,time:time.value,room:room.value,topic:topic.value};if(!d.date||!d.time||!d.room||!d.topic){ok.textContent='请填完日期、时间、会议室和主题';return;}
const r=await (await fetch('/api/book',{method:'POST',body:JSON.stringify(d)})).json();ok.textContent=r.error?r.error:'预订成功，编号 '+r.id;}</script>`),
  "/mine": () => html("我的预订", `${bookings.filter(b => !b.cancelled).map(b => `<p>编号 ${b.id}：${b.date} ${b.time} ${b.room}「${b.topic}」 <button type="button" onclick="fetch('/api/cancel',{method:'POST',body:'${b.id}'}).then(()=>location.reload())">取消编号 ${b.id}</button></p>`).join("") || "<p>还没有预订。</p>"}<p><a href="/book">去预订</a></p>`),
  "/laptops": () => html("笔记本", `<ul>${LAPTOPS.map(l => `<li><a href="/laptop/${l.id}">${l.name}</a></li>`).join("")}</ul>`),
};

const site = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0]!;
  hits.push({ path, at: Date.now() });
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    if (req.method === "POST" && path === "/api/book") {
      const d = JSON.parse(body) as Omit<Booking, "id" | "cancelled" | "at">;
      const room = ROOMS.find(r => r.name === d.room);
      const clash = room?.taken === `${d.date} ${d.time}` || bookings.some(b => !b.cancelled && b.room === d.room && b.date === d.date && b.time === d.time);

      if (clash) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ error: "这个时间这间已被订" })); return; }
      const b = { ...d, id: bookings.length + 1, cancelled: false, at: Date.now() };
      bookings.push(b);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: b.id }));

      return;
    }

    if (req.method === "POST" && path === "/api/cancel") {
      const b = bookings.find(x => x.id === Number(body));

      if (b) b.cancelled = true;
      res.writeHead(200).end("{}");

      return;
    }
    const laptop = LAPTOPS.find(l => path === `/laptop/${l.id}`);
    const page = laptop ? html(laptop.name, `<p>价格：${laptop.price} 元</p><p>重量：${laptop.kg} kg</p><p><a href="/laptops">返回列表</a></p>`) : pages[path]?.();
    res.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(page ?? "not found");
  });
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const BOOK = "帮我订 10 月 12 日 15:00 能坐 8 人以上的会议室，主题写周会。会议室信息在这一页。";

type Task = { id: string; start: string; ask: string; turn: string; when: "after" | ((path: string) => boolean); judge: (answer: string) => { ok: boolean; why: string }; oldDirection: (since: number) => number };

const active = () => bookings.filter(b => !b.cancelled);

const TASKS: Task[] = [
  { id: "follow", start: "/rooms", ask: BOOK, turn: "要带投影仪的。", when: "after",
    judge: () => { const a = active(); const ok = a.length === 1 && a[0]!.room === "金桂" && a[0]!.date === "10 月 12 日" && a[0]!.time === "15:00";

      return { ok, why: `有效预订：${a.map(b => `${b.date} ${b.time} ${b.room}`).join("、") || "无"}` }; },
    oldDirection: since => bookings.filter(b => b.at > since && !ROOMS.find(r => r.name === b.room)?.projector).length },
  { id: "redirect", start: "/rooms", ask: BOOK, turn: "改成 10 月 13 日。", when: path => path === "/book",
    judge: () => { const a = active(); const ok = a.length === 1 && a[0]!.date === "10 月 13 日" && a[0]!.time === "15:00" && (ROOMS.find(r => r.name === a[0]!.room)?.cap ?? 0) >= 8;

      return { ok, why: `有效预订：${a.map(b => `${b.date} ${b.time} ${b.room}`).join("、") || "无"}；12 日订过 ${bookings.filter(b => b.date === "10 月 12 日").length} 次` }; },
    oldDirection: since => bookings.filter(b => b.at > since && b.date === "10 月 12 日").length },
  { id: "addinfo", start: "/laptops", ask: "看看这 5 款笔记本，告诉我哪款最轻。", turn: "只看 6000 元以下的。", when: path => path.startsWith("/laptop/"),
    // 只看最后一段回答（跳过回答下面「按上次做过的…」那行）：说最轻的是晨风，而且没把别的型号说成最轻。
    judge: answer => { const last = answer.split("\n").filter(l => l.trim() && !l.startsWith("按上次做过的") && !/^(来源|\d+ 秒)/.test(l.trim())).at(-1) ?? ""; const named = [...last.matchAll(/(青羽|云帆|星河|极光|晨风)[^，。；]{0,8}最轻|最轻的?是?[^，。；]{0,4}(青羽|云帆|星河|极光|晨风)/g)].map(m => m[1] ?? m[2]);

      return { ok: named.length > 0 && named.every(n => n === "晨风"), why: last.slice(0, 160) }; },
    oldDirection: since => hits.filter(h => h.at > since && LAPTOPS.some(l => h.path === `/laptop/${l.id}` && l.price > 6000)).length },
];

const IDLE = `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")`;

const rows: Array<Record<string, unknown>> = [];

const rp = await launchRealPath();

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(await loadModelPlan(modelId)))}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#status-dot")?.classList.contains("on")`) || undefined, 90_000, "侧栏连上", 500);
  const say = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); return Date.now(); };
  // 回答后目标核对约 3 秒才决定接着做，期间侧栏显示空闲：连续 16 秒空闲才算这一题做完。
  const waitIdle = async (label: string) => { await sleep(1500); let quiet = 0;

    for (const end = Date.now() + 300_000; Date.now() < end && quiet < 32; await sleep(500)) quiet = await rp.evaluate(panel, IDLE) ? quiet + 1 : 0;

    if (quiet < 32) throw new Error(`${label} 5 分钟没做完`); };

  for (const task of TASKS.filter(t => !only || only.includes(t.id))) for (let i = 1; i <= repeat; i++) {
    bookings = []; hits = [];
    await rp.click(panel, "#conversation-new");
    await until(async () => await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && ${IDLE}`) || undefined, 60_000, "新会话");
    await rp.cdp.send("Page.navigate", { url: `${origin}${task.start}` }, work);
    await sleep(800);
    await rp.cdp.send("Page.bringToFront", {}, work);
    const askedAt = await say(task.ask);
    let turnAt = 0;

    if (task.when === "after") { await waitIdle(`${task.id}-${i} 第一句`); await sleep(3000); turnAt = await say(task.turn); }
    else {
      const trigger = task.when;
      await until(async () => hits.some(h => h.at > askedAt && trigger(h.path)) || undefined, 180_000, `${task.id}-${i} 等插话时机`, 100).catch(() => undefined);
      turnAt = await say(task.turn);
    }

    await waitIdle(`${task.id}-${i}`);
    await sleep(4000);
    const doneAt = Date.now();
    const answer = String(await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant")].map(m => m.innerText).join("\\n")`));

    const verdict = task.judge(answer);
    rows.push({ task: task.id, run: i, askedAt, turnAt, doneAt, ok: verdict.ok, why: verdict.why, oldDirectionSteps: task.oldDirection(turnAt), firstAskToTurnMs: turnAt - askedAt });
    console.log(`${task.id}-${i}\t${verdict.ok ? "对" : "错"}\t旧方向多做 ${task.oldDirection(turnAt)} 步\t${verdict.why}`);
    await rp.screenshot(panel, join(out, `${task.id}-${i}-panel.png`)).catch(() => {});
  }

  const { traces } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(out, "downloads"));
  await writeFile(join(out, "traces.jsonl"), traces);
} finally {
  await writeFile(join(out, "rows.json"), JSON.stringify({ model: modelId, rows }, null, 2));
  await rp.close(); await rp.remove(); site.close();
}

console.log(`读数：${out}`);
