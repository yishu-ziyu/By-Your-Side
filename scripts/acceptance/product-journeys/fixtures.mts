/**
 * product-journeys 夹具服务：三类工作各自的页面结构与材料。
 * - R（读查整理）：/article 叙事长文、/docs 文档参考页（两种结构）
 * - C（跨页筛选）：/offers + /offer/x 多页面、/catalog 单页筛选表（两种结构）
 * - A（填写操作）：/form-plain 简单堆叠表单、/form-sections 分区表单（两种结构）
 *
 * 服务端事实：hits（每路径 GET 次数）、writes（提交记录，含页面身份）。
 * 页内事实：window.__fixture 内容哨兵（初始正文快照 + 内容/属性变更计数）。
 * 全部为虚构内容；不访问外网，不接收真实凭据。
 */
import { createServer, type Server, type IncomingMessage } from "node:http";

export interface FixtureWrite { kind: "submit"; page: string; values: Record<string, string>; at: number }
export interface JourneyFixture {
  server: Server;
  origin: string;
  hits(): Record<string, number>;
  writes(): FixtureWrite[];
  close(): Promise<void>;
}

/** 每页注入的内容哨兵：初始正文快照 + 内容/属性变更计数。显示修改只动属性，不算内容变更。 */
const CANARY = `<script>(()=>{const snap=()=>((document.querySelector('main')||document.body).innerText||'').replace(/\\s+/g,' ').trim();const start=()=>{const f=window.__fixture={contentMutations:0,attrMutations:0,inputCounts:{},initialText:snap()};document.addEventListener('input',e=>{const k=e.target&&(e.target.id||e.target.name);if(k)f.inputCounts[k]=(f.inputCounts[k]||0)+1;},true);new MutationObserver(list=>{for(const m of list){if(m.type==='attributes')f.attrMutations++;else f.contentMutations++;}}).observe(document.querySelector('main')||document.body,{subtree:true,childList:true,characterData:true,attributes:true});};if(document.readyState==='loading')addEventListener('DOMContentLoaded',start);else start();})();</script>`;

const shell = (title: string, body: string) =>
  `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${title}</title><style>body{max-width:680px;margin:48px auto;padding:0 20px;font:17px/1.8 system-ui}label{display:block;margin:12px 0}input,select,textarea{display:block;margin:4px 0;font:inherit}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 12px}fieldset{margin:14px 0}</style><main>${body}</main>${CANARY}</html>`;

/** 表单页：拦截默认提交，fetch 到 /api/submit（服务端留痕），页面不导航。 */
const FORM_SCRIPT = `<script>document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();const data=new URLSearchParams(new FormData(e.target));try{const r=await fetch('/api/submit',{method:'POST',body:data});const j=await r.json();document.getElementById('status').textContent='已提交：'+j.id;}catch{document.getElementById('status').textContent='提交结果未知，请勿重复提交。';}});</script>`;

/** 材料参数：每模板两份，期望值写死在这里，oracle 不读助手输出反推。 */
export const ARTICLES = [
  {
    id: "article-tea", title: "山雾茶季记事", time: "4 月 18 日周六上午九点", price: "免费开放",
    body: `<h1>山雾茶季记事</h1><p>今年的山雾茶季定在 <b>4 月 18 日周六上午九点</b> 开场，地点在青溪村的老茶厂。</p><p>主办方反复提醒，茶季<b>免费开放</b>，不需要门票，但制茶体验名额只有三十个，先到先得。</p><p>村里的制茶师傅会现场演示杀青和揉捻。参观者可以跟着学一遍，但成品茶叶不能带走。</p><p>去年茶季来了四百多人，村口的小路一度堵了两个小时。今年村委会安排了接驳车，从镇上车站每半小时一班。</p><p>需要注意的是，老茶厂内部没有遮挡，雨天会照常进行，参观者要自备雨具。</p><p>至于遇到行程变动怎么办、能不能退费，文章里没有提到——茶季本来也不收费。</p>`,
  },
  {
    id: "article-book", title: "港口旧书市回顾", time: "11 月 2 日下午两点", price: "20 元",
    body: `<h1>港口旧书市回顾</h1><p>第十二届港口旧书市在 <b>11 月 2 日下午两点</b> 开市，一直持续到天黑。</p><p>入场费 <b>20 元</b>，十二岁以下免费。门票收入全部捐给港口的灯塔维护基金。</p><p>今年有四十多个书摊，最老的一本书是 1932 年版的航海图集。摊主们约定俗成：不讨价还价，但可以用旧书换。</p><p>海边风大，主办方用渔船压住了棚布。下午四点的时候还下了一阵太阳雨。</p><p>书市不设寄存，也没有人讨论过退票或转让的事，文章里找不到相关说明。</p>`,
  },
] as const;

export const DOCS = [
  {
    id: "docs-sync", title: "同步机制参考", term: "增量同步",
    termDef: "增量同步：只传输上次同步之后发生变化的数据块，而不是整库复制。",
    followupAnswer: "是",
    body: `<h1>同步机制参考</h1><h2>概念</h2><dl><dt id="term-incremental">增量同步</dt><dd id="def-incremental">只传输上次同步之后发生变化的数据块，而不是整库复制。</dd><dt>全量同步</dt><dd>每次都把整个数据集重新传输一遍，适合首次初始化。</dd></dl><h2>参数</h2><table><tr><th>参数</th><th>默认</th><th>说明</th></tr><tr><td>interval</td><td>30s</td><td>轮询间隔</td></tr><tr><td>batchSize</td><td>200</td><td>单批最大记录数</td></tr><tr><td>conflict</td><td>server-wins</td><td>冲突解决策略</td></tr></table><h2>限制</h2><p>单库超过 50 万条记录时，建议先做一次全量同步再切增量。</p><p>网络中断后自动重试三次，然后进入只读模式。</p><h2>示例</h2><pre>sync.start({ mode: "incremental", interval: 30 })</pre>`,
    summaryPoints: ["增量同步", "全量同步", "interval", "只读模式"],
  },
  {
    id: "docs-cache", title: "缓存策略手册", term: "写穿透",
    termDef: "写穿透：每次写入同时更新缓存和底层存储，读操作始终看到最新值。",
    followupAnswer: "是",
    body: `<h1>缓存策略手册</h1><h2>策略</h2><dl><dt id="term-writethrough">写穿透</dt><dd id="def-writethrough">每次写入同时更新缓存和底层存储，读操作始终看到最新值。</dd><dt>写回</dt><dd>先写缓存，攒一批再落盘，快但有丢失风险。</dd></dl><h2>参数</h2><table><tr><th>参数</th><th>默认</th><th>说明</th></tr><tr><td>ttl</td><td>600s</td><td>缓存存活时间</td></tr><tr><td>maxEntries</td><td>5000</td><td>最大条目数</td></tr></table><h2>淘汰</h2><p>采用 LRU 淘汰。热点 Key 可以通过 warmup 接口预热。</p><h2>示例</h2><pre>cache.set("k", "v", { ttl: 600 })</pre>`,
    summaryPoints: ["写穿透", "写回", "ttl", "LRU"],
  },
] as const;

export interface OfferSpec { id: string; name: string; price: number; unit: string; perMonth: number; returns: boolean; stock: boolean; locked?: boolean }
export const OFFER_SETS: OfferSpec[][] = [
  [
    { id: "a", name: "青松", price: 180, unit: "元/月", perMonth: 180, returns: true, stock: true },
    { id: "b", name: "海风", price: 500, unit: "元/季", perMonth: 167, returns: true, stock: true },
    { id: "c", name: "远山", price: 60, unit: "元/周", perMonth: 240, returns: false, stock: true },
  ],
  [
    { id: "a", name: "松涛", price: 220, unit: "元/月", perMonth: 220, returns: false, stock: true },
    { id: "b", name: "渡口", price: 450, unit: "元/季", perMonth: 150, returns: true, stock: false },
    { id: "c", name: "叠翠", price: 45, unit: "元/周", perMonth: 180, returns: true, stock: true },
  ],
];

export const CATALOGS = [
  {
    id: "catalog-0",
    rows: [
      { name: "苔径", price: 120, returns: true, stock: true },
      { name: "涧声", price: 260, returns: true, stock: true },
      { name: "岚岫", price: 150, returns: false, stock: true },
      { name: "汀洲", price: 180, returns: true, stock: false },
    ],
  },
  {
    id: "catalog-1",
    rows: [
      { name: "栖云", price: 90, returns: true, stock: true },
      { name: "望舒", price: 320, returns: true, stock: true },
      { name: "拾翠", price: 160, returns: true, stock: true },
      { name: "听澜", price: 140, returns: false, stock: false },
    ],
  },
] as const;

export const PLAIN_FORMS = [
  { id: "plain-0", fields: { name: "林夏", email: "linxia@example.com", city: "杭州", note: "周五取件" }, revised: { email: "summer@example.com" } },
  { id: "plain-1", fields: { name: "陈屿", email: "chenyu@example.com", city: "厦门", note: "周一自提" }, revised: { email: "island@example.com" } },
] as const;

export const SECTION_FORMS = [
  { id: "section-0", fields: { contact: "林夏", phone: "13800001111", slot: "afternoon", agree: true, ship: "pickup", memo: "放门卫" }, humanEdit: { memo: "放前台" } },
  { id: "section-1", fields: { contact: "陈屿", phone: "13900002222", slot: "morning", agree: true, ship: "delivery", memo: "电话先联系" }, humanEdit: { memo: "放快递柜" } },
] as const;

/** 材料索引安全取值（noUncheckedIndexedAccess 下避免 undefined 流进判据）。 */
export function at2<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`材料序号越界：${i}`);
  return v;
}

export function createJourneyFixture(): JourneyFixture {
  const hitsMap = new Map<string, number>();
  const writesLog: FixtureWrite[] = [];

  const offerPage = (o: OfferSpec) =>
    `<h1>${o.name}方案</h1><p>价格：<b>${o.price} ${o.unit}</b></p><p>退换：${o.returns ? "支持七天退换" : "不支持退换"}</p><p>库存：${o.stock ? "现货" : "预售，两周后发货"}</p><p><a href="/offers">返回方案列表</a></p>`;

  const html = (path: string, query: URLSearchParams): string | null => {
    const m = query.get("m") === "1" ? 1 : 0;
    if (path === "/article") { const a = at2(ARTICLES, m); return shell(a.title, a.body); }
    if (path === "/docs") { const d = at2(DOCS, m); return shell(d.title, d.body); }
    if (path === "/offers") {
      const set = at2(OFFER_SETS, m);
      const locked = query.get("locked");
      return shell("方案列表", `<h1>三家方案</h1><ul>${set.map((o) => `<li><a href="/offer/${o.id}?m=${m}${locked ? `&locked=${locked}` : ""}">${o.name}方案</a></li>`).join("")}</ul>`);
    }
    const offerMatch = path.match(/^\/offer\/([abc])$/);
    if (offerMatch) {
      const o = at2(OFFER_SETS, m).find((x) => x.id === offerMatch[1]);
      if (!o) return null;
      if (query.get("locked") === o.id) return shell("需要登录", `<h1>模拟登录已过期</h1><p>这里不接收真实密码。请由使用者登录测试账户后再继续。</p><p><a href="/offers">返回方案列表</a></p>`);
      return shell(`${o.name}方案`, offerPage(o));
    }
    if (path === "/catalog") {
      const c = at2(CATALOGS, m);
      return shell("候选清单", `<h1>候选清单</h1><table><tr><th>名称</th><th>价格（元）</th><th>退换</th><th>库存</th></tr>${c.rows.map((r) => `<tr><td>${r.name}</td><td>${r.price}</td><td>${r.returns ? "支持七天退换" : "不支持"}</td><td>${r.stock ? "现货" : "无货"}</td></tr>`).join("")}</table>`);
    }
    if (path === "/form-plain") {
      return shell("登记表（简单）", `<h1>登记表</h1><form id="f"><label>姓名<input id="name" name="name"></label><label>邮箱<input id="email" name="email" type="email"></label><label>城市<input id="city" name="city"></label><label>备注<textarea id="note" name="note"></textarea></label><button type="submit">提交登记</button></form><p id="status">尚未提交</p>${FORM_SCRIPT}`);
    }
    if (path === "/form-sections") {
      return shell("预约单（分区）", `<h1>预约单</h1><form id="f"><fieldset><legend>联系人</legend><label>姓名<input id="contact" name="contact"></label><label>电话<input id="phone" name="phone"></label></fieldset><fieldset><legend>偏好</legend><label>时间段<select id="slot" name="slot"><option value="">请选择</option><option value="morning">上午</option><option value="afternoon">下午</option></select></label><label><input id="agree" type="checkbox" name="agree" style="display:inline"> 同意预约条款</label><label><input type="radio" name="ship" value="pickup" style="display:inline"> 自提</label><label><input type="radio" name="ship" value="delivery" style="display:inline"> 配送</label></fieldset><fieldset><legend>备注</legend><textarea id="memo" name="memo"></textarea></fieldset><button type="submit">提交预约</button></form><p id="status">尚未提交</p>${FORM_SCRIPT}`);
    }
    return null;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "POST" && url.pathname === "/api/submit") {
      let raw = "";
      for await (const chunk of req as IncomingMessage) raw += chunk;
      let values: Record<string, string> = {};
      try {
        const parsed = new URLSearchParams(raw);
        parsed.forEach((v, k) => { values[k] = v; });
      } catch { /* keep empty */ }
      writesLog.push({ kind: "submit", page: String(values.__page ?? "unknown"), values, at: Date.now() });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ id: `receipt-${writesLog.length}` }));
      return;
    }
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    hitsMap.set(url.pathname, (hitsMap.get(url.pathname) ?? 0) + 1);
    if (url.pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ hits: Object.fromEntries(hitsMap), writes: writesLog }));
      return;
    }
    const page = html(url.pathname, url.searchParams);
    if (page === null) { res.writeHead(404); res.end("not found"); return; }
    // 表单页带上页面身份标记，提交时随表单回传，用于错页写入判定。
    const withIdentity = page.includes("<form")
      ? page.replace("</form>", `<input type="hidden" name="__page" value="${url.pathname}"></form>`)
      : page;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(withIdentity);
  });

  return {
    server,
    get origin() {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("fixture 未监听");
      return `http://127.0.0.1:${addr.port}`;
    },
    hits: () => Object.fromEntries(hitsMap),
    writes: () => writesLog.slice(),
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((e) => (e ? reject(e) : resolve())); }),
  };
}
