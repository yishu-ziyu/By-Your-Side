/** 练习站独立 oracle：请求与 POST 在服务端收录，不靠模型的完成宣称。 */
import { createServer } from "node:http";
import { siteAddress } from "./harness.mts";

export const TERMS = ["Model Context Protocol", "Computer Use"];

export const HOSTS = ["blog.test", "wiki.test", "x.test", "flomo.test"];

export const EXPLANATIONS = [
  ["Model Context Protocol 是连接模型与外部工具的开放协议。", "它让应用通过统一接口提供上下文。", "使用工具时仍需控制权限并核对结果。"],
  ["Computer Use 让助手通过界面操作电脑。", "助手可以观察页面并点击或填写字段。", "涉及写入时需要用户确认并检查实际结果。"],
];

export const POST_TEXT = "使用 Model Context Protocol 时，应该把工具权限与执行结果分开核对。";

export interface SiteRequest { method: string; host: string; path: string; time: string }

export interface MemoPost { time: string; body: string; ordinal: number; responseAt: string | null; delayMs: number }

const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const html = (title: string, body: string) => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1>${body}</body></html>`;

export async function startNorthStarSites(delayNth = 0, delayMs = 0) {
  const requests: SiteRequest[] = [];
  const posts: MemoPost[] = [];

  const memoPage = (draft = "") => html("Flomo 练习站", `<form method="post" action="/api/memo"><label for="note">笔记全文</label><textarea id="note" name="content" rows="12" cols="90">${escapeHtml(draft)}</textarea><button id="save" type="submit">保存</button></form><h2>已保存</h2><ol id="saved">${posts.map(p => `<li>${escapeHtml(p.body)}</li>`).join("")}</ol><output id="save-status"></output><script>
    document.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      document.querySelector('#save-status').textContent = '保存中';
      try {
        // URLSearchParams 使用 textarea 的实际文本，不做原生表单的 CRLF 转换。
        const response = await fetch('/api/memo', {method:'POST', body:new URLSearchParams({content:document.querySelector('#note').value})});
        if (!response.ok) throw new Error('保存失败');
        const page = new DOMParser().parseFromString(await response.text(), 'text/html');
        document.querySelector('#saved').innerHTML = page.querySelector('#saved').innerHTML;
        document.querySelector('#save-status').textContent = '已保存';
      } catch (error) { document.querySelector('#save-status').textContent = '保存结果不确定'; }
    });
  </script>`);

  const server = createServer(async (req, res) => {
    const host = String(req.headers.host ?? "").split(":")[0]!;
    const url = new URL(req.url ?? "/", `http://${host || "localhost"}`);
    requests.push({ method: req.method ?? "GET", host, path: url.pathname + url.search, time: new Date().toISOString() });
    const reply = (body: string, status = 200) => res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);

    if (!HOSTS.includes(host)) {
      reply(html("未知站点", "404"), 404);

      return;
    }

    if (host === "flomo.test" && req.method === "POST" && url.pathname === "/api/memo") {
      let raw = "";

      for await (const chunk of req) raw += chunk;
      const body = new URLSearchParams(raw).get("content") ?? "";
      const ordinal = posts.length + 1;
      const wait = ordinal === delayNth ? delayMs : 0;
      const post: MemoPost = { time: new Date().toISOString(), body, ordinal, responseAt: null, delayMs: wait };
      posts.push(post);

      if (wait) await new Promise(done => setTimeout(done, wait));
      post.responseAt = new Date().toISOString();
      reply(memoPage(body));

      return;
    }

    if (req.method !== "GET") {
      reply(html("不支持的方法", "405"), 405);

      return;
    }

    if (host === "blog.test" && url.pathname === "/post") {
      reply(html("Agent 的工具与界面", "<article><p>Agent 可以借助 <b>Model Context Protocol</b> 连接外部工具，也可以通过 <b>Computer Use</b> 操作网页。本文讨论上下文、权限与执行结果的边界。</p></article>"));

      return;
    }

    // 维基首页只有一个搜索框：在框里按回车即由浏览器原生提交表单（GET /search?q=…）。
    if (host === "wiki.test" && url.pathname === "/") {
      reply(html("维基练习站", '<form action="/search" method="get"><label for="q">搜索</label><input id="q" name="q" type="search"></form>'));

      return;
    }

    const term = url.searchParams.get("q") ?? "";
    const index = TERMS.indexOf(term);

    if (host === "wiki.test" && url.pathname === "/search") {
      reply(html("维基搜索", index < 0 ? "<p>无结果</p>" : `<ul id="results"><li><a href="/wiki/${encodeURIComponent(term)}">${escapeHtml(term)}</a></li></ul>`));

      return;
    }

    if (host === "wiki.test" && url.pathname.startsWith("/wiki/")) {
      const entry = TERMS.indexOf(decodeURIComponent(url.pathname.slice(6)));
      reply(entry < 0 ? html("无词条", "无结果") : html(TERMS[entry]!, `<section id="summary">${EXPLANATIONS[entry]!.map(s => `<p>${s}</p>`).join("")}</section>`), entry < 0 ? 404 : 200);

      return;
    }

    if (host === "x.test" && url.pathname === "/search") {
      reply(html("X 搜索", index !== 0 ? '<p id="results">无结果</p>' : `<ul id="results"><li><span>工具观察者</span><p>${POST_TEXT}</p><a href="/status/1">帖子链接</a></li></ul>`));

      return;
    }

    if (host === "x.test" && url.pathname === "/status/1") {
      reply(html("工具观察者", `<article id="post">${POST_TEXT}</article>`));

      return;
    }

    if (host === "flomo.test" && url.pathname === "/") {
      reply(memoPage());

      return;
    }

    reply(html("未找到", "404"), 404);
  });

  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));

  return {
    requests, posts,
    resolver: `--host-resolver-rules=${HOSTS.map(h => `MAP ${h} 127.0.0.1:${siteAddress(server).port}`).join(", ")}`,
    close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }),
  };
}
