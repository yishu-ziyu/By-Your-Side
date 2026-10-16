import { createServer } from "node:http";
const head = t => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>本地测试页 · ${t}</title><style>body{font-family:sans-serif;margin:30px}label{display:block;margin:8px 0}fieldset{margin:12px 0}.modal{position:fixed;inset:0;background:#0006;display:flex;align-items:center;justify-content:center}.box{background:#fff;padding:24px;min-width:380px}</style></head><body><p style="color:#a00">本地测试页（仅本机，不会提交到任何真实网站）</p>`;
const pages = {
"/a": head("注册表单") + `<h1>注册账号</h1><form onsubmit="event.preventDefault()">
<label>姓名 <input id="name" name="name" required></label>
<label>邮箱 <input id="email" name="email" type="email" required></label>
<label>手机号 <input id="phone" name="phone" type="tel" required></label>
<label>公司 <input id="company" name="company"></label>
<label>职位 <select id="role" name="role" required><option value="">请选择</option><option>工程师</option><option>产品经理</option><option>设计师</option><option>销售</option></select></label>
<label><input id="agree" type="checkbox" required> 我同意服务条款</label>
<label><input id="news" type="checkbox"> 订阅产品资讯</label>
<button type="submit">注册</button></form></body></html>`,
"/b": head("项目登记") + `<h1>项目登记</h1><form onsubmit="event.preventDefault()">
<fieldset><legend>项目信息</legend>
<label>项目名 <input id="proj" required></label>
<label>标题 <input id="title1" required></label>
<label>副标题 <input id="subtitle"></label></fieldset>
<fieldset><legend>首篇文章</legend>
<label>标题 <input id="title2" required></label>
<label>备注 <textarea id="memo"></textarea></label></fieldset>
<fieldset><legend>其他</legend>
<label>备注标题 <input id="memotitle"></label>
<label>项目名缩写 <input id="abbr"></label></fieldset>
<button type="submit">保存</button></form></body></html>`,
"/c": head("预约弹窗") + `<h1>门店服务</h1><button id="open" onclick="document.getElementById('dlg').hidden=false">预约服务</button>
<div id="dlg" class="modal" hidden role="dialog" aria-modal="true" aria-labelledby="dt"><div class="box"><h2 id="dt">预约到店</h2><form onsubmit="event.preventDefault();document.getElementById('ok').hidden=false">
<label>联系人 <input id="cname" required></label>
<label>到店日期 <input id="date" type="date" required></label>
<label>服务类型 <select id="svc" required><option value="">请选择</option><option>保养</option><option>维修</option><option>洗车</option><option>检测</option></select></label>
<label>备注 <input id="cnote"></label>
<button type="button" onclick="document.getElementById('dlg').hidden=true">取消</button> <button type="submit">确认预约</button><p id="ok" hidden>已预约（本地）</p></form></div></div></body></html>`,
};
createServer((q, s) => { const p = pages[q.url.split("?")[0]]; s.writeHead(p ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(p ?? "nf"); }).listen(8966, "127.0.0.1");
