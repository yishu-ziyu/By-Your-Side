import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { launchRealPath, requireHeadless, siteAddress, until, REPO } from "../acceptance/real-path/harness.mts";
requireHeadless();
const cases = [
  { id: "chinese-form", goal: "把姓名填成小王，不要提交。", html: '<h1>登记表</h1><label>姓名<input id="name"></label><label>邮箱<input id="email"></label><button>提交</button>', expected: "c0", completed: [] },
  { id: "same-name", goal: "打开乙店的详情，不是甲店。", html: '<section><h2>甲店</h2><button>详情</button></section><section><h2>乙店</h2><button>详情</button></section>', expected: "c1", completed: [] },
  { id: "next-page", goal: "第一页看完了，去下一页，不要删除筛选。", html: '<h1>供应商 · 第1页</h1><a href="/3">下一页</a><button>删除筛选</button>', expected: "c0", completed: ["已读取第1页"] },
  { id: "continue-read", goal: "已读取目录第一页。读取第二页供应商的电话，不要申请或返回。", html: '<h1>第二页供应商</h1><span data-read="phone">电话：010-12345678</span><button>申请合作</button><a href="/2">返回上一页</a>', expected: "c0", completed: ["已读取目录第一页", "已进入第二页"] },
];
const site = createServer((req, res) => {
  const c = cases[Number(req.url?.slice(1))] ?? cases[0]!;
  res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<title>${c.id}</title>${c.html}`);
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const out = join(REPO, "out/acceptance/session-recovery/jev-decisions");
await mkdir(out, { recursive: true });
const rp = await launchRealPath();
const frozen = [];
try {
  const tab = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(tab.targetId);
  for (const [i, c] of cases.entries()) {
    const url = `http://127.0.0.1:${siteAddress(site).port}/${i}`;
    await rp.cdp.send("Page.navigate", { url }, work);
    await until(async () => await rp.evaluate(work, `document.title===${JSON.stringify(c.id)}`) || undefined, 10_000, "fixture loaded");
    const observation = await rp.evaluate(work, 'document.body.innerText');
    const candidates = await rp.evaluate(work, `Object.fromEntries([...document.querySelectorAll('input,button,a,[data-read]')].map((e,i)=>['c'+i,{action:e.matches('[data-read]')?'read':e.tagName==='INPUT'?'fill':'click',name:e.tagName==='INPUT'?e.closest('label')?.innerText:e.innerText,region:e.closest('section')?.querySelector('h2')?.innerText??document.querySelector('h1')?.innerText,id:e.id||null}]))`);
    const state = { goal: c.goal, capturedAt: new Date().toISOString(), url, observation, completed: c.completed, candidates, scope: "controlled real DOM, not everyday task success" };
    const raw = JSON.stringify(state, null, 2), source = join(out, `${c.id}.json`);
    await writeFile(source, raw); await rp.screenshot(work, join(out, `${c.id}.png`));
    frozen.push({ id: c.id, source, sha256: createHash("sha256").update(raw).digest("hex"), expected: c.expected });
  }
  await writeFile(join(out, "cases.json"), JSON.stringify(frozen, null, 2));
  console.log(JSON.stringify({ out, cases: frozen.length }));
} finally { await rp.close(); await rp.remove(); site.closeAllConnections(); site.close(); }
