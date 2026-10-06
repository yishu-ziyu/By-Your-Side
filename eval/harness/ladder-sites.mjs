/**
 * Local pages for complexity-ladder tasks that no stable public site offers (task URLs say `{ladder}`).
 * /oopif: a checkout page on 127.0.0.1 whose card form comes from localhost — another site, so Chrome runs
 * it as a cross-site iframe (its own process), like a real payment widget. The form reports what is typed to
 * the top page, so the final page text shows it.
 */
import { createServer } from "node:http";

const page = (body) => `<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;margin:24px}label{display:block;margin:10px 0}</style>${body}`;

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

    res.writeHead(404).end();
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  server.unref();

  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
