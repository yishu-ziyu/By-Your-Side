/** 真网站、ChatGPT 登录模型、有窗口隔离 Chrome。只读 Wikipedia，后台开窗，不碰日常扩展。 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, until, sleep } from "./harness.mts";
import { loadModelPlan, modelStorageItems } from "./inproc-config.mts";
if (!process.argv.includes('--live')) throw new Error('需要 --live 明确运行真实模型');
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g,'-')}-reading-live`);
await mkdir(out, {recursive:true});
const plan = await loadModelPlan('openai-codex/gpt-6-luna');
const rp = await launchRealPath({headed:true});
type Node = {backendNodeId:number;attributes?:string[];children?:Node[];shadowRoots?:Node[]};
const checks: Array<{name:string;pass:boolean;detail:unknown}> = [];
const check=(name:string,pass:boolean,detail:unknown)=>{checks.push({name,pass,detail});console.log(pass?'PASS':'FAIL',name,JSON.stringify(detail));};
try {
  const target=(await rp.targets()).find(t=>t.url==='about:blank')!;
  const work=await rp.attach(target.targetId);
  await rp.cdp.send('Page.enable',{},work);
  await rp.cdp.send('Page.navigate',{url:'https://en.wikipedia.org/wiki/Lighthouse'},work);
  await until(()=>rp.evaluate(work,'!!document.querySelector("#mw-content-text p") && !!document.querySelector("[data-sideagent-ask]")'),45000,'真实灯塔文章');
  const panel=await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({...modelStorageItems(plan),inproc_fast_model_config: {provider: plan.providerId, modelId: plan.modelId}})}).then(()=>true)`);
  await until(()=>rp.evaluate(panel,'document.querySelector("#conversation-new")?.disabled===false'),60000,'模型就绪');
  const read=async<T,>(fn:string):Promise<T>=>{
    const doc=await rp.cdp.send('DOM.getDocument',{depth:-1,pierce:true},work) as {root:Node};
    const find=(n:Node):Node|undefined=>{if(n.attributes?.includes('data-sideagent-ask'))return n.shadowRoots?.[0];for(const c of [...(n.children??[]),...(n.shadowRoots??[])]){const r=find(c);if(r)return r;}};
    const n=find(doc.root);if(!n)throw Error('没有阅读卡');
    const obj=await rp.cdp.send('DOM.resolveNode',{backendNodeId:n.backendNodeId},work);
    const r=await rp.cdp.send('Runtime.callFunctionOn',{objectId:obj.object.objectId,functionDeclaration:fn,returnByValue:true},work);
    if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;
  };
  const click=async(selector:string)=>{
    const p=await read<{x:number;y:number}>(`function(){const e=this.querySelector(${JSON.stringify(selector)});if(!e||e.closest('[hidden]'))throw Error('控件不可见');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}`);
    for(const type of ['mouseMoved','mousePressed','mouseReleased'])await rp.cdp.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...p},work);
  };
  const span=await rp.evaluate(work,`(()=>{const p=[...document.querySelectorAll('#mw-content-text p')].find(p=>p.textContent.trim().startsWith('A lighthouse'));if(!p)throw Error('没有定义段落');p.scrollIntoView({block:'center'});const r=document.createRange();r.selectNodeContents(p);const a=r.getClientRects()[0],b=[...r.getClientRects()].at(-1);return {x1:a.left+1,y1:a.top+a.height/2,x2:b.right-1,y2:b.top+b.height/2}})()`) as {x1:number;y1:number;x2:number;y2:number};
  await rp.cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true},work);
  await rp.cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:span.x1,y:span.y1},work);
  for(let i=1;i<=10;i++)await rp.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:span.x1+(span.x2-span.x1)*i/10,y:span.y1+(span.y2-span.y1)*i/10},work);
  await rp.cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:span.x2,y:span.y2},work);
  const selected=await rp.evaluate(work,'getSelection().toString()');
  check('真实网页划选灯塔定义',String(selected).includes('lighthouse'),selected);
  await until(()=>read<boolean>(`function(){return !this.querySelector('.surface').hidden&&!this.querySelector('.bar').hidden}`),5000,'划词入口');
  await click('[data-act="explain"]');
  await until(()=>read<boolean>(`function(){return !!this.querySelector('.answer')?.textContent.trim()&&!this.querySelector('.status')?.textContent.trim()}`),90000,'真实模型回答');
  await sleep(300);
  await rp.screenshot(work,join(out,'summary.png'));
  const result=await read<{answer:string;summary:string;details:boolean;width:number;error:string}>(`function(){return {answer:this.querySelector('.answer')?.textContent??'',summary:this.querySelector('.answer-summary:not([hidden])')?.textContent??'',details:!!this.querySelector('.details:not([hidden])'),width:this.querySelector('.surface').getBoundingClientRect().width,error:this.querySelector('.error:not([hidden])')?.textContent??''}}`);
  check('真实模型返回内容，小卡片没有错误',result.answer.length>30&&result.width<=320&&!result.error,result);
  if(result.details){await click('[data-act="details"]');check('可展开完整回答',await read<boolean>(`function(){return !this.querySelector('.answer').hidden&&this.querySelector('.answer').innerText.length>30}`),{});await rp.screenshot(work,join(out,'expanded.png'));}
  await click('[data-act="followup"]');
  await rp.typeText(work,'用一句中文说明它为什么能帮助船舶。');await rp.pressEnter(work);
  await until(()=>read<boolean>(`function(){const a=[...this.querySelectorAll('.turn')].at(-1);return this.querySelectorAll('.turn').length===2&&!!a.querySelector('.answer')?.textContent.trim()&&!a.querySelector('.status')?.textContent.trim()}`),90000,'真实模型追问');
  const follow=await read<string>(`function(){return [...this.querySelectorAll('.answer')].at(-1)?.textContent??''}`);
  check('真实追问得到回答',follow.length>10,follow);
  await rp.screenshot(work,join(out,'followup.png'));
} catch(e){check('流程完成',false,String(e));}
finally{await writeFile(join(out,'result.json'),JSON.stringify({status:checks.length&&checks.every(c=>c.pass)?'PASS':'FAIL',model:'openai-codex/gpt-6-luna',checks},null,2));await rp.close();await rp.remove();}
console.log(`证据：${out}`);if(!checks.length||checks.some(c=>!c.pass))process.exitCode=1;
