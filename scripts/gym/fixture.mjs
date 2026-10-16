import { createServer } from 'node:http';

export const seeds = [11, 29, 47];
export const tasks = ['todo', 'form', 'search'];
const data = [
  { id: 'a', name: '浏览器基础', category: '书籍', available: true },
  { id: 'b', name: '浏览器自动化', category: '书籍', available: true },
  { id: 'c', name: '浏览器海报', category: '海报', available: true },
  { id: 'd', name: '浏览器历史', category: '书籍', available: false },
  { id: 'e', name: '网络基础', category: '书籍', available: true },
];

export function requestFor(task, fault = 'none') {
  if(fault==='waiting') return {text:'先填写姓名为「林晓」、邮箱为「lin.xiao@example.com」。备注先不要填，等我确认后再填。不要提交表单，也不要改其他字段。',automaticCorrection:false};
  const text = {
    todo: '新增两项待办：「阅读论文」和「整理实验」，然后将第一项标记为完成。不要新增其他项目。',
    form: '填写姓名为「林晓」、邮箱为「lin.xiao@example.com」、备注为「请保留草稿」，但不要提交表单，也不要改变其他字段。',
    search: '搜索「浏览器」，再筛选类别为「书籍」且「仅看有货」的结果。',
  }[task];
  return {text,automaticCorrection:true};
}

function page(task, seed, fault) {
  const order = seed === 29 ? ['note', 'name', 'email'] : seed === 47 ? ['email', 'note', 'name'] : ['name', 'email', 'note'];
  const fields = { name: '<label>姓名<input name="name" autocomplete="off"></label>', email: '<label>邮箱<input name="email" type="email" autocomplete="off"></label>', note: '<label>备注<textarea name="note"></textarea></label>' };
  const controls = ['<label>搜索<input name="query" type="search"></label>', '<label>类别<select name="category"><option>全部</option><option>书籍</option><option>海报</option></select></label>', '<label><input name="available" type="checkbox">仅看有货</label>'];
  const body = task === 'todo' ? '<label>新待办<input name="todo" placeholder="输入后按回车"></label><ul id="items"></ul>' : task === 'form' ? `<form>${order.map(x => fields[x]).join('')}<label>部门<input name="department" value="研发"></label><label><input name="newsletter" type="checkbox" checked>接收通知</label><button type="submit">提交</button></form>` : `<section>${(seed === 11 ? controls : [...controls].reverse()).join('')}</section><ul id="results"></ul>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>BYS 练习 ${task}</title><style>body{font:18px system-ui;margin:${seed === 29 ? '60px 14%' : '32px'};background:${seed === 47 ? '#ecf2f5' : '#fafafa'};color:#1b2830}main{max-width:840px}label{display:block;margin:20px 0}input,textarea,select,button{font:inherit;margin:8px;padding:8px}li{padding:10px;list-style:none;border-bottom:1px solid #ccd}section{display:${seed === 29 ? 'flex' : 'block'};flex-wrap:wrap}input[type=checkbox]{width:22px;height:22px}</style><main><h1>${{ todo: '待办清单', form: '联系资料', search: '资料目录' }[task]}</h1>${body}<p role="status" id="status">就绪</p></main><script>(()=>{
const task=${JSON.stringify(task)}, data=${JSON.stringify(data)}, delay=${seed === 29 ? 900 : 0}, fault=${JSON.stringify(fault)};
const status=document.getElementById('status'); let dropped=false, timer;
const delayed=(fn,replace=true)=>{status.textContent='更新中…';if(replace)clearTimeout(timer);timer=setTimeout(()=>{fn();status.textContent='已更新'},delay)};
if(task==='todo'){
  let items=JSON.parse(localStorage.getItem('todos')||'[]');
  const list=document.getElementById('items'), input=document.querySelector('[name=todo]');
  function render(){list.replaceChildren();items.forEach((item,i)=>{const li=document.createElement('li'),label=document.createElement('label'),box=document.createElement('input'),text=document.createElement('span');box.type='checkbox';box.checked=item.done;text.textContent=item.text;box.addEventListener('change',e=>{if(!e.isTrusted)return;items[i].done=box.checked;save()});label.append(box,text);li.append(label);list.append(li)});}
  function save(){localStorage.setItem('todos',JSON.stringify(items));render()}
  document.addEventListener('keydown',e=>{const input=e.target;if(input.name!=='todo'||e.key!=='Enter'||!e.isTrusted||!input.value.trim())return;e.preventDefault();const text=input.value.trim();input.value='';if(fault==='drop'&&!dropped){dropped=true;status.textContent='已更新';return}delayed(()=>{items.push({text,done:false});save()},false)});render();
}else if(task==='form'){
 document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();fetch('/submit',{method:'POST',body:'submitted'});status.textContent='已提交'});
 if(['drop','late-drop'].includes(fault))document.querySelector('[name=note]').addEventListener('input',e=>{if(e.isTrusted&&e.target.value&&!dropped){dropped=true;setTimeout(()=>{e.target.value='';status.textContent='已更新';fetch('/event',{method:'POST',body:'note-cleared'})},fault==='late-drop'?1500:50)}});
}else{
 function render(){const query=document.querySelector('[name=query]'),category=document.querySelector('[name=category]'),available=document.querySelector('[name=available]');const rows=data.filter(x=>x.name.includes(query.value)&& (category.value==='全部'||x.category===category.value)&&(!available.checked||x.available));document.getElementById('results').replaceChildren(...rows.map(x=>{const li=document.createElement('li');li.dataset.id=x.id;li.textContent=x.name+' · '+x.category+' · '+(x.available?'有货':'缺货');return li}))}
 document.addEventListener('input',e=>{if(['query','category','available'].includes(e.target.name))delayed(render)});render();
}
if(fault==='stale')document.addEventListener('input',function replace(e){if(!e.isTrusted)return;document.removeEventListener('input',replace);setTimeout(()=>{for(const el of document.querySelectorAll('[name]')){const focused=document.activeElement===el,copy=el.cloneNode(true);copy.value=el.value;if(el.type==='checkbox')copy.checked=el.checked;el.replaceWith(copy);if(focused)copy.focus()}status.textContent='页面已局部更新';fetch('/event',{method:'POST',body:'controls-replaced'})},50)});
})()</script></html>`;
}

/** No evaluator endpoint exists. Expected answers stay in the Node evaluator. */
export async function startFixture(task, seed, fault = 'none') {
  if (!tasks.includes(task) || !seeds.includes(seed) || !['none', 'drop', 'stale', 'late-drop', 'unknown', 'waiting'].includes(fault)) throw new Error('invalid fixture');
  const effects = [], events = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' }).end(page(task, seed, fault));
    } else if (req.method === 'POST' && req.url === '/submit') {
      effects.push({ type: 'submit', at: Date.now() }); req.resume(); res.writeHead(204).end();
    } else if(req.method==='POST' && req.url==='/event'){
      let body='';req.on('data',c=>{if(body.length<64)body+=c});req.on('end',()=>{events.push({at:Date.now(),event:body.slice(0,64)});res.writeHead(204).end()});
    } else { res.writeHead(404).end('Not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, effects, events, close: () => new Promise(resolve => server.close(resolve)) };
}
