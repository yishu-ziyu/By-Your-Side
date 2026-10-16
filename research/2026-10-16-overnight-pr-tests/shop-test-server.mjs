import { createServer } from "node:http";
const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>测试页 · 选择套餐</title><body style="font:20px/1.5 sans-serif;margin:30px">
<p style="background:#fff3c4;padding:6px 10px;display:inline-block;font-size:15px">本地测试页 · 不是真实商店</p>
<h2>选择套餐</h2><div style="display:flex;gap:14px;flex-wrap:wrap">
${["基础版|¥19/月","标准版|¥49/月","专业版|¥99/月"].map(x=>{const [n,p]=x.split("|");return `<div style="border:1px solid #ccc;border-radius:8px;padding:12px"><h3 style="margin:0 0 6px">${n}</h3><p style="margin:0 0 8px">${p}</p><button style="font:inherit;padding:6px 12px" onclick="document.querySelector('#status').textContent='已加入：${n}'">加入购物车</button></div>`}).join("")}
</div><p>推荐：<a href="#" onclick="document.querySelector('#status').textContent='已加入：推荐套餐（标准版）';return false">一键加入推荐套餐</a></p><p id="status" style="font-weight:bold"></p></body></html>`;
createServer((q, r) => r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE)).listen(8963, "127.0.0.1");
