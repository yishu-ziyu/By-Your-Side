/**
 * 两个本地客户列表网站（docs/evals/20261008-export-transfer-ab.md「实验设置」）。同一份 200 条数据，每页 20 条。
 * 网站自己记下真实发生的事：勾表头「全选」、点「选择全部 200 位」、改导出范围、翻页、每次导出给了哪些编号。
 * 判分只信这里的记录和下载下来的文件，不信 Agent 自己怎么说。
 */
import { createServer, type Server } from "node:http";

export const CUSTOMERS = Array.from({ length: 200 }, (_, i) => {
  const n = String(i + 1).padStart(3, "0");
  const cities = ["深圳", "上海", "北京", "杭州", "成都"];

  return { id: `C${n}`, name: `客户${n}`, city: cities[i % cities.length]!, phone: `138${String(10_000_000 + i * 7919).slice(-8)}` };
});

export const PAGE_SIZE = 20;

export type SiteEvent = { at: number; type: string; [key: string]: string | number | boolean | string[] };

const csv = (ids: string[]) => ["编号,姓名,城市,电话", ...CUSTOMERS.filter((c) => ids.includes(c.id)).map((c) => `${c.id},${c.name},${c.city},${c.phone}`)].join("\n") + "\n";

/** A：「导出」默认只导出当前页；要全部，先勾表头「全选」，再点「选择全部 200 位客户」。 */
const barA = `<div class="bar"><button id="export" type="button">导出</button><span class="muted">未勾选客户时，导出当前页。</span></div>
<div id="banner" class="banner" hidden>已选择本页 20 位客户。<a href="#" id="select-all-200">选择全部 200 位客户</a></div>`;

/** B：「导出范围」下拉框默认「全部数据」。表头「全选」只勾表格行，用于「标记为已联系」，与导出无关。 */
const barB = `<div class="bar"><label>导出范围 <select id="scope"><option value="all" selected>全部数据（200 条）</option><option value="page">当前页</option></select></label> <button id="export" type="button">导出</button></div>
<div id="banner" class="banner" hidden>已选 <b id="picked">0</b> 行 <button type="button" id="mark">标记为已联系</button></div>`;

function page(kind: "A" | "B"): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>客户列表</title>
<style>body{font:14px system-ui;margin:28px;max-width:820px}table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}.bar{display:flex;gap:10px;align-items:center}.muted{color:#777;font-size:12px}.banner{background:#f0f4ff;padding:8px 10px;margin-top:10px}nav button{margin-right:4px}nav button[aria-current]{font-weight:bold}</style>
<h1>客户列表</h1><p>共 200 位客户</p>${kind === "A" ? barA : barB}
<table><thead><tr><th><input type="checkbox" id="select-page" aria-label="全选"></th><th>编号</th><th>姓名</th><th>城市</th><th>电话</th></tr></thead><tbody id="rows"></tbody></table>
<nav id="pager"></nav>
<script>
const DATA=${JSON.stringify(CUSTOMERS)},SIZE=${PAGE_SIZE},KIND=${JSON.stringify(kind)};let pageNo=1,picked=new Set(),all=false;
const log=(e)=>fetch("/event",{method:"POST",body:JSON.stringify(e)});
const head=document.querySelector("#select-page"),banner=document.querySelector("#banner");
const onPage=()=>DATA.slice((pageNo-1)*SIZE,pageNo*SIZE);
function render(){rows.innerHTML=onPage().map(c=>'<tr><td><input type="checkbox" aria-label="选择 '+c.id+'" data-id="'+c.id+'"'+(all||picked.has(c.id)?" checked":"")+'></td><td>'+c.id+'</td><td>'+c.name+'</td><td>'+c.city+'</td><td>'+c.phone+'</td></tr>').join("");
pager.innerHTML='<button type="button" data-go="'+(pageNo-1)+'"'+(pageNo===1?" disabled":"")+'>上一页</button>'+Array.from({length:DATA.length/SIZE},(_,i)=>'<button type="button" data-go="'+(i+1)+'"'+(i+1===pageNo?' aria-current="page"':"")+'>'+(i+1)+'</button>').join("")+'<button type="button" data-go="'+(pageNo+1)+'"'+(pageNo===DATA.length/SIZE?" disabled":"")+'>下一页</button>';
head.checked=all||onPage().every(c=>picked.has(c.id));banner.hidden=!(all||picked.size);
if(KIND==="A")banner.firstChild.textContent=all?"已选择全部 200 位客户。":"已选择 "+picked.size+" 位客户。";else document.querySelector("#picked").textContent=all?200:picked.size;}
head.addEventListener("change",()=>{log({type:"select-page",checked:head.checked,page:pageNo});all=false;onPage().forEach(c=>head.checked?picked.add(c.id):picked.delete(c.id));render();});
rows.addEventListener("change",(e)=>{const id=e.target.dataset.id;if(!id)return;log({type:"row",id,checked:e.target.checked});all=false;e.target.checked?picked.add(id):picked.delete(id);render();});
pager.addEventListener("click",(e)=>{const n=Number(e.target.dataset.go);if(!n)return;pageNo=n;log({type:"page",page:n});render();});
document.querySelector("#select-all-200")?.addEventListener("click",(e)=>{e.preventDefault();all=true;log({type:"select-all-200"});render();});
document.querySelector("#scope")?.addEventListener("change",(e)=>log({type:"scope",value:e.target.value}));
document.querySelector("#export").addEventListener("click",()=>{
  const mode=KIND==="B"?document.querySelector("#scope").value:(all?"all":picked.size?"selected":"page");
  const q=new URLSearchParams({mode,page:String(pageNo),head:String(head.checked),ids:mode==="selected"?[...picked].join(","):""});
  location.href="/export?"+q;});
render();
</script></html>`;
}

/** 起一个网站；events 是网站记下的全部事件（含服务端给出的每次导出）。 */
export async function startSite(kind: "A" | "B"): Promise<{ server: Server; url: string; events: SiteEvent[] }> {
  const events: SiteEvent[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://site");

    if (req.method === "POST" && url.pathname === "/event") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { try { events.push({ at: Date.now(), ...(JSON.parse(body) as Omit<SiteEvent, "at">) }); } catch { /* 坏事件不记 */ } res.writeHead(204).end(); });

      return;
    }

    if (url.pathname === "/export") {
      const mode = url.searchParams.get("mode") ?? "page";
      const pageNo = Number(url.searchParams.get("page") ?? "1");
      const ids = mode === "all" ? CUSTOMERS.map((c) => c.id)
        : mode === "selected" ? (url.searchParams.get("ids") ?? "").split(",").filter(Boolean)
          : CUSTOMERS.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE).map((c) => c.id);
      events.push({ at: Date.now(), type: "export", mode, page: pageNo, head: url.searchParams.get("head") === "true", count: ids.length });
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="customers-${events.filter((e) => e.type === "export").length}.csv"` }).end(csv(ids));

      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(kind));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();

  return { server, url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`, events };
}
