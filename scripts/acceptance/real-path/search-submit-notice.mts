/**
 * Real extension and pages: submitting a search box (a GET form the page lets the browser follow) does not tell the
 * user "网站已收到，无法恢复"; a POST address form, and a form the page intercepts and sends itself, still do.
 *   npx tsx scripts/acceptance/real-path/search-submit-notice.mts --headless [--only=search,order,spa]
 * The model is scripted (its fill and click are fixed per case), so this proves the browser and panel layer.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,sleep,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-search-submit-notice`);
await mkdir(out,{recursive:true});
const page=(title:string,body:string)=>`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`;
const site=createServer((req,res)=>{
 const path=(req.url??'/').split('?')[0];
 const html=path==='/search'?page('搜索',`<form role="search" action="/results"><input id="field" name="q" type="search" aria-label="搜索"><button id="go">搜索</button></form>`)
  :path==='/results'?page('搜索结果',`<p>搜索结果：${new URL(req.url??'/','http://x').searchParams.get('q')}</p>`)
  :path==='/order'?page('收货地址',`<form method="post" action="/done"><label>收件人 <input id="field" name="name"></label><button id="go">保存地址</button></form>`)
  :path==='/done'?page('已保存','<p>地址已保存</p>')
  :path==='/spa'?page('预约',`<form id="f"><label>姓名 <input id="field" name="name"></label><button id="go">提交预约</button></form><p id="sent" hidden>预约已提交</p><script>document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();fetch('/book',{method:'POST'}).then(()=>{document.getElementById('sent').hidden=false})})</script>`)
  :page('ok','<p>ok</p>');
 res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(html);
});
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${siteAddress(site).port}`;
const NOTICE=/网站已收到|扩展撤不回/;
const CASES=[
 {id:'search',path:'/search',value:'故宫',landed:'搜索结果：故宫',notice:false},
 {id:'order',path:'/order',value:'张三',landed:'地址已保存',notice:true},
 {id:'spa',path:'/spa',value:'李四',landed:'预约已提交',notice:true},
];
const only=process.argv.find(a=>a.startsWith('--only='))?.slice(7).split(',');
const results:Array<{id:string;status:'pass'|'fail';panel?:string;error?:string}>=[];

for(const item of CASES.filter(c=>!only||only.includes(c.id))){
 const task=`提交提示验收${item.id}：在这页填好并提交。`;
 const model=await startScriptedModel([
  {match:task,steps:[{tool:{name:'navigate',args:{url:origin+item.path}}},{tool:{name:'fill',args:{target:'#field',value:item.value}}},{tool:{name:'click',args:{target:'#go'}}},{text:`提交提示验收${item.id}完成。`}]},
 ]);
 const rp=await launchRealPath();let panel='',text='';
 try{
  panel=await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
  await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'sidebar ready');
  await rp.click(panel,'#input');await rp.typeText(panel,task);await rp.pressEnter(panel);
  await until(()=>rp.evaluate(panel,`document.body.innerText.includes(${JSON.stringify(`提交提示验收${item.id}完成`)})`),60000,'scripted run finished');
  const landed=await until(async()=>{for(const t of await rp.targets()){if(!t.url.startsWith(origin))continue;const s=await rp.attach(t.targetId);if(String(await rp.evaluate(s,'document.body.innerText')).includes(item.landed))return true;}return undefined;},15000,'page shows the submit result');
  assert.ok(landed);
  // 还原状态由后台推给侧栏：等它到齐再看。
  await sleep(2500);
  text=String(await rp.evaluate(panel,'document.body.innerText'));
  assert.equal(NOTICE.test(text),item.notice,`${item.id}: ${item.notice?'still says the site got it':'no "site got it" notice'}`);
  await rp.screenshot(panel,join(out,`${item.id}-panel.png`));
  results.push({id:item.id,status:'pass'});
 }catch(e){
  results.push({id:item.id,status:'fail',panel:text.slice(-400),error:String(e).split('\n')[0]});
  if(panel)await rp.screenshot(panel,join(out,`${item.id}-failure.png`)).catch(()=>{});
 }finally{await rp.close();await rp.remove();await model.close();}
 console.log(JSON.stringify(results.at(-1)));
}
await new Promise<void>(r=>site.close(()=>r()));
const failed=results.filter(r=>r.status==='fail');
await writeFile(join(out,'result.json'),JSON.stringify({status:failed.length?'fail':'pass',results,dependency:'real isolated extension and pages; scripted model'},null,2));
console.log(JSON.stringify({status:failed.length?'fail':'pass',passed:results.length-failed.length,total:results.length,out}));
if(failed.length)process.exitCode=1;
