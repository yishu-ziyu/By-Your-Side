export const RESEARCH_COMPANIES = [
  { id: "jia", name: "甲星虚构公司", business: "工厂视觉检测", funding: "天使轮" },
  { id: "yi", name: "乙河虚构公司", business: "农田灌溉传感器", funding: "A轮" },
  { id: "bing", name: "丙林虚构公司", business: "废旧电池回收", funding: "未公开" },
] as const;

const layout = (title: string, body: string) => `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.6 sans-serif;max-width:760px;margin:24px auto;padding:0 20px}
input,button{font:inherit;padding:8px}li{margin:12px 0}a{color:#0759a0}</style>
</head><body><main><h1>${title}</h1>${body}</main></body></html>`;

/** 公司业务和融资只出现在各自详情页，列表不会提前泄露未读事实。 */
export function researchPage(pathname: string): string | null {
  if (pathname === "/research") {
    const links = RESEARCH_COMPANIES.map(company => `<li><a href="/research/${company.id}?token=fixture-query-secret">${company.name}</a></li>`).join("");
    return layout("虚构公司调研", `<form id="research-search"><label>搜索公司 <input id="search"></label>
<button type="submit">搜索</button></form><ul id="results">${links}</ul>
<script>document.getElementById("research-search").addEventListener("submit", event => {
event.preventDefault();document.getElementById("results").hidden = false;
});</script>`);
  }

  const company = RESEARCH_COMPANIES.find(item => pathname === `/research/${item.id}`);
  if (!company) return null;
  return layout(company.name, `<p id="business">业务：${company.business}</p><p id="funding">融资：${company.funding}</p>
<a href="/research">返回列表</a>`);
}
