/**
 * Local pages for complexity-ladder tasks that no stable public site offers (task URLs say `{ladder}`).
 * /oopif: a checkout page on 127.0.0.1 whose card form comes from localhost — another site, so Chrome runs
 * it as a cross-site iframe (its own process), like a real payment widget. The form reports what is typed to
 * the top page, so the final page text shows it.
 */
import { createServer } from "node:http";

const page = (body) => `<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;margin:24px}label{display:block;margin:10px 0}</style>${body}`;

/** 插话评测页面的写入记录：{t, type, name, value}，t 是 Date.now()，和 harness 同一台机器的时钟。 */
const DUPLEX_LOG = `<script>
  (() => {
    const read = () => JSON.parse(localStorage.getItem("duplexLog") || "[]");
    const record = (type, name, value) => {
      const log = read(), last = log.at(-1), t = Date.now();
      // 连续打字合成一条，记最后的值和时刻
      if (type === "input" && last?.type === "input" && last.name === name && t - last.t < 1500) Object.assign(last, { t, value });
      else log.push({ t, type, name, value: String(value ?? "").slice(0, 200) });
      localStorage.setItem("duplexLog", JSON.stringify(log));
    };
    window.__duplexRecord = record;
    const val = (el) => el.type === "checkbox" ? el.value + "=" + el.checked : el.type === "radio" ? (el.checked ? el.value : "") : el.value;
    addEventListener("input", (e) => e.target.name && e.target.type !== "checkbox" && e.target.type !== "radio" && record("input", e.target.name, val(e.target)), true);
    addEventListener("change", (e) => e.target.name && val(e.target) !== "" && record("change", e.target.name, val(e.target)), true);
    addEventListener("submit", () => record("submit", "form", ""), true);
    addEventListener("load", () => record("load", location.pathname + location.search, ""));
  })();
</script>`;

const DUPLEX_BOOKS = [
  ["夜航西飞", "传记", 42, 7], ["银河帝国：基地", "科幻", 39, 12], ["三体", "科幻", 58, 30], ["东方快车谋杀案", "悬疑", 35, 9], ["白夜行", "悬疑", 49, 4],
  ["沙丘", "科幻", 68, 6], ["飞鸟集", "诗歌", 25, 19], ["海子诗全集", "诗歌", 88, 2], ["嫌疑人X的献身", "悬疑", 39, 15], ["你一生的故事", "科幻", 45, 11],
  ["无人生还", "悬疑", 32, 22], ["神经漫游者", "科幻", 49, 3], ["草叶集", "诗歌", 56, 8], ["恶意", "悬疑", 36, 19], ["光年之外", "科幻", 29, 14],
  ["火车", "悬疑", 46, 5], ["边城", "小说", 22, 31], ["北岛诗选", "诗歌", 33, 10], ["球状闪电", "科幻", 48, 17], ["长夜难明", "悬疑", 52, 6],
  ["呼啸山庄", "小说", 27, 13], ["流浪地球", "科幻", 26, 25], ["荒原", "诗歌", 41, 4], ["占星术杀人魔法", "悬疑", 44, 7], ["海伯利安", "科幻", 72, 9],
  ["围城", "小说", 30, 20], ["献给阿尔吉侬的花束", "科幻", 38, 16], ["唐诗三百首", "诗歌", 19, 40], ["罗杰疑案", "悬疑", 34, 12], ["时间机器", "科幻", 21, 18],
].map(([title, cat, price, stock]) => ({ title, cat, price, stock }));

export async function startLadderSites() {
  const server = createServer((req, res) => {
    const port = server.address().port;
    const path = new URL(req.url, "http://x").pathname;
    const send = (html) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(html));

    if (path === "/oopif") return send(`<title>结账</title><h1>结账</h1><p>商品：机械键盘 × 1，合计 ¥499</p>
      <iframe src="http://localhost:${port}/card-form" title="银行卡" style="width:420px;height:260px;border:1px solid #ccc"></iframe>
      <p id="seen">支付框里还没有填写内容。</p>
      <script>addEventListener("message", (e) => { if (e.origin === "http://localhost:${port}") document.getElementById("seen").textContent = e.data === "已付款" ? "已付款" : "支付框里已填：" + e.data; });</script>`);

    if (path === "/card-form") return send(`<title>银行卡</title>
      <label>持卡人 <input name="holder" autocomplete="off"></label>
      <label>卡号 <input name="card" autocomplete="off"></label>
      <label>有效期 <input name="exp" placeholder="MM/YY" autocomplete="off"></label>
      <button type="button" onclick="parent.postMessage('已付款', 'http://127.0.0.1:${port}')">付款</button>
      <script>document.addEventListener("input", () => parent.postMessage([...document.querySelectorAll("input")].map((i) => i.name + "=" + i.value).join("; "), "http://127.0.0.1:${port}"));</script>`);

    // 插话评测（eval/tasks/duplex.md）：页面自己记下每次写入的时刻和值，存在 localStorage `duplexLog`，翻页也不丢。
    // 这份记录不经过扩展和模型，所以「插话后还写了旧值」「停下后还动了页面」以它为准。
    if (path === "/duplex-form") return send(`<title>订餐</title><h1>订餐</h1>${DUPLEX_LOG}
      <form id="f">
        <label>姓名 <input name="name"></label>
        <label>电话 <input name="phone"></label>
        <label>邮箱 <input name="email"></label>
        <label>城市 <select name="city"><option value="">请选择</option><option>北京</option><option>上海</option><option>深圳</option><option>广州</option></select></label>
        <fieldset><legend>份量</legend>${["小份", "中份", "大份"].map((s) => `<label><input type="radio" name="size" value="${s}"> ${s}</label>`).join("")}</fieldset>
        <fieldset><legend>加料</legend>${["培根", "洋葱", "蘑菇", "青椒", "芝士"].map((s) => `<label><input type="checkbox" name="topping" value="${s}"> ${s}</label>`).join("")}</fieldset>
        <label>送达时间 <input name="time" placeholder="例如 18:30"></label>
        <label>备注 <textarea name="notes" rows="3" cols="40"></textarea></label>
        <button type="submit">提交订单</button>
      </form><p id="state">未提交</p>
      <script>document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); document.getElementById("state").textContent = "已提交"; });</script>`);

    if (path === "/duplex-list") {
      const n = Math.min(3, Math.max(1, Number(new URL(req.url, "http://x").searchParams.get("page")) || 1));
      const rows = DUPLEX_BOOKS.slice((n - 1) * 10, n * 10).map((b) => `<tr><td>${b.title}</td><td>${b.cat}</td><td>¥${b.price}</td><td>库存 ${b.stock}</td><td><button type="button" data-book="${b.title}">加入清单</button></td></tr>`).join("");

      return send(`<title>书店 第 ${n} 页</title><h1>书店（第 ${n} / 3 页）</h1>${DUPLEX_LOG}
        <table border="1" cellpadding="4"><tr><th>书名</th><th>分类</th><th>价格</th><th>库存</th><th></th></tr>${rows}</table>
        <p>${[1, 2, 3].map((i) => i === n ? `<b>${i}</b>` : `<a href="/duplex-list?page=${i}">第 ${i} 页</a>`).join(" · ")}</p>
        <h2>我的清单</h2><ul id="cart"></ul>
        <script>
          const cart = () => JSON.parse(localStorage.getItem("duplexCart") || "[]");
          const draw = () => { document.getElementById("cart").innerHTML = cart().map((t) => "<li>" + t + " <button type=button data-remove='" + t + "'>移除</button></li>").join("") || "<li>（空）</li>"; };
          document.addEventListener("click", (e) => {
            const add = e.target.dataset?.book, rm = e.target.dataset?.remove;
            if (add && !cart().includes(add)) localStorage.setItem("duplexCart", JSON.stringify([...cart(), add]));
            if (rm) localStorage.setItem("duplexCart", JSON.stringify(cart().filter((t) => t !== rm)));
            if (add || rm) { window.__duplexRecord?.(add ? "cart_add" : "cart_remove", add || rm); draw(); }
          });
          draw();
        </script>`);
    }

    if (path === "/duplex-chat") return send(`<title>和小王的聊天</title><h1>小王</h1>${DUPLEX_LOG}
      <ul id="msgs"><li>小王：明天的会定了吗？</li></ul>
      <label>消息 <textarea name="message" rows="3" cols="40" placeholder="回车发送"></textarea></label>
      <button type="button" id="send">发送</button>
      <script>
        const box = document.querySelector("[name=message]");
        const sendIt = () => { if (!box.value.trim()) return; window.__duplexRecord?.("send", box.value); document.getElementById("msgs").insertAdjacentHTML("beforeend", "<li>我：" + box.value.replace(/</g, "&lt;") + "</li>"); box.value = ""; };
        document.getElementById("send").addEventListener("click", sendIt);
        box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendIt(); } });
      </script>`);

    res.writeHead(404).end();
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  server.unref();

  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
