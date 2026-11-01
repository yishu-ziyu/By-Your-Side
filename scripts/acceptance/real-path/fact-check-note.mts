/**
 * Real extension, sidebar and page; scripted local model (the main answer and the delivery fact check are scripted replies).
 * The user is already reading the delivered answer, so a fact check must never take it away:
 * 甲 answers a wrong price → the original answer stays on screen the whole time, one 「更正：」 line with the page quote is appended,
 *   no second model turn starts and the panel never goes back to thinking;
 * 乙 answers right → nothing is shown;
 * 丙 the checker cites a quote the assistant never read → the answer is left untouched.
 * Failure: the answer disappears or is rewritten, a correction turn runs, a 「请核对」 note appears, or an ungrounded finding changes the answer.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,sleep,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-fact-check-note`);await mkdir(out,{recursive:true});
const apiKey='sk-AbCd1234EfGh5678IjKl9012';
const recovery='ABCD-EF12-34GH';
const password='PasswordFixture1234';
const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(`<!doctype html><title>密钥管理</title><main><h1>Aura 降噪耳机</h1><p>限时价 ¥899</p><button id="mutate" onclick="this.textContent='发生了写操作'">试验操作</button><p>API key: ${apiKey}</p><p>恢复码 ${recovery}</p><label>密码 <input type="password" value="${password}"></label><label>备注 <input value="普通备注"></label></main>`));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${siteAddress(site).port}/`;
const PROBLEM='请核对价格：页面写的是 ¥899，回答写成 ¥999。';
const STUCK='页面写的是缺货。';
const read={tool:{name:'browser_run',args:{label:'读价格',code:`const s=await browser.navigate({url:${JSON.stringify(origin)}});return s.text.slice(0,400);`}}};
const factPrompts:string[]=[];
let correctionTurns=0;
const flag = (kind: string, claim: string, text: string) => ({ kind, claim, text, source: kind === 'contradiction' ? 'Aura 降噪耳机' : null, quote: kind === 'contradiction' ? '限时价 ¥899' : null });
const model=await startScriptedModel([
 // the delivery fact check carries the user's words after "USER REQUEST:"; the main conversation never does.
 {match:'USER REQUEST: 核对验收甲',steps:[{text:JSON.stringify({problems:[flag('contradiction','这副耳机现在卖 ¥999。',PROBLEM)]})}]},
 {match:'USER REQUEST: 核对验收乙',steps:[{text:JSON.stringify({problems:[]})}]},
 // 丙: a contradiction whose quote is not in anything the assistant read.
 {match:'USER REQUEST: 核对验收丙',steps:[{text:JSON.stringify({problems:[{kind:'contradiction',claim:'这副耳机有货，可以直接下单。',source:'Aura 降噪耳机',quote:'库存：缺货',text:STUCK}]})}]},
 {match:'USER REQUEST: 核对验收旧轮',steps:[{text:JSON.stringify({problems:[flag('contradiction','旧轮价格是 ¥999。',PROBLEM)]}),delayMs:4000}]},
 {match:'USER REQUEST: 核对验收新轮',steps:[{text:JSON.stringify({problems:[]})}]},
 {match:'核对验收旧轮',steps:[read,{text:'旧轮价格是 ¥999。'}]},
 {match:'核对验收新轮',steps:[{text:'这是新任务的回答，不处理上一轮。'}]},
 {match:'核对验收甲',steps:[read,{text:'这副耳机现在卖 ¥999。'}]},
 {match:'核对验收乙',steps:[read,{text:'这副耳机限时价 ¥899。'}]},
 {match:'核对验收丙',steps:[read,{text:'这副耳机有货，可以直接下单。'}]},
],undefined,payload=>{const msgs=payload.messages??[];
 const textOf=(message:typeof msgs[number])=>typeof message.content==='string'?message.content:(message.content??[]).map(part=>part.text??'').join('');
 if(msgs.some(m=>m.role==='user'&&textOf(m).includes('[GOAL CHECK] Resolve')))correctionTurns++;
 for(const message of payload.messages??[]){const text=typeof message.content==='string'?message.content:(message.content??[]).map(part=>part.text??'').join('');if(text.includes('PAGE NOW (snapshot, form values included):'))factPrompts.push(text);}});
const rp=await launchRealPath();let error='';let panel='';const evidence:Record<string,unknown>={};
const answers=`[...document.querySelectorAll('#messages .msg.assistant')].filter(a=>a.checkVisibility()).map(a=>({text:a.innerText.slice(0,80),checked:a.dataset.factChecked??null,note:a.querySelector('.fact-check')?.innerText??null}))`;
// once 甲's answer is on screen it must stay there through every later DOM change (a scripted model answers in milliseconds, so watch every mutation)
const watchAnswer=`(()=>{const m=document.querySelector('#messages');const shown=()=>[...m.querySelectorAll('.msg.assistant')].some(a=>a.checkVisibility()&&a.innerText.includes('这副耳机现在卖 ¥999。'));new MutationObserver(()=>{if(shown())window.sawWrong=true;else if(window.sawWrong)window.lostAnswer=true;if(m.textContent.includes('对照网页改正回答'))window.sawFix=true;}).observe(m,{subtree:true,childList:true,characterData:true,attributes:true});return true})()`;
try{
 panel=await rp.attach(await rp.openSidePanel());await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
 await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'ready');
 await rp.evaluate(panel,watchAnswer);
 type Answer={text:string;checked:string|null;note:string|null};
 const settled:Record<string,(a:Answer[])=>boolean>={
  核对验收甲:a=>a.some(x=>x.text.includes('更正')&&x.checked!==null),
  核对验收乙:a=>a.some(x=>x.text.startsWith('这副耳机限时价 ¥899。')&&!x.text.includes('更正')&&x.checked!==null),
  核对验收丙:a=>a.some(x=>x.text.startsWith('这副耳机有货，可以直接下单。')&&x.checked!==null),
 };
 for(const mark of Object.keys(settled)){
  await rp.click(panel,'#input');await rp.typeText(panel,mark);await rp.pressEnter(panel);
  await until(async()=>settled[mark]!(await rp.evaluate(panel,answers) as Answer[])||undefined,120000,`fact check settled (${mark})`);
 }
 await sleep(1500);
 evidence.watch=await rp.evaluate(panel,`({sawWrong:window.sawWrong===true,lostAnswer:window.lostAnswer===true,sawFix:window.sawFix===true})`);
 const before=await rp.evaluate(panel,answers) as Answer[];evidence.before=before;
 assert.ok(factPrompts.length>=3,`fact checks: 甲, 乙 and 丙 once each (got ${factPrompts.length})`);
 for(const prompt of factPrompts){
  const page=prompt.split('PAGE NOW (snapshot, form values included):\n<<<\n')[1]?.split('\n>>>')[0]??'';
  assert.ok(page.includes('限时价 ¥899'),'current page snapshot reached the fact-check model');
  assert.ok(page.includes('普通备注'),'ordinary form value remains available for verification');
  for(const secret of [apiKey,recovery,password])assert.ok(!prompt.includes(secret),'fixture credential must not reach the fact-check model');
  assert.ok(page.includes('[redacted]'),'credential redaction is visible in the page snapshot');
 }
 await rp.screenshot(panel,join(out,'notes.png'));
 const watch=evidence.watch as {sawWrong:boolean;lostAnswer:boolean;sawFix:boolean};
 assert.ok(watch.sawWrong,'甲 answer appeared');
 assert.equal(watch.lostAnswer,false,'delivered answer never disappeared');
 assert.equal(watch.sawFix,false,'panel never went back to correcting');
 assert.equal(correctionTurns,0,'no correction model turn');
 const fixed=before.find(a=>a.text.includes('更正'));
 assert.ok(fixed&&fixed.text.startsWith('这副耳机现在卖 ¥999。'),'original answer kept in place');
 assert.ok(fixed!.text.includes('限时价 ¥899'),'correction quotes the page');
 assert.equal(fixed!.note,null,'no note under the corrected answer');
 assert.equal(before.filter(a=>a.text.includes('更正')).length,1,'corrected once, no loop');
 const clean=before.find(a=>a.text.startsWith('这副耳机限时价 ¥899。')&&!a.text.includes('更正'));
 assert.ok(clean&&clean.note===null&&clean.checked==='0','nothing under the answer that checks out');
 const stuck=before.at(-1)!;
 assert.equal(stuck.note,null,'internal fact-check diagnostics must not become a user card');
 assert.ok(!stuck.text.includes('更正')&&!stuck.text.includes('无法确认'),'ungrounded finding leaves the answer untouched');
 assert.ok(!before.some(a=>(a.note??'').includes('请核对 ')),'no 「请核对 N 处」 title');
 const workTarget=(await rp.targets()).find(t=>t.type==='page'&&t.url===origin);
 assert.ok(workTarget,'source page exists');
 const work=await rp.attach(workTarget!.targetId);
 assert.equal(await rp.evaluate(work,`document.querySelector('#mutate').textContent`),'试验操作','fact check never writes to the page');
 await rp.cdp.send('Page.reload',{},panel);
 await until(()=>rp.evaluate(panel,`document.querySelectorAll('#messages .msg.assistant').length>=3`),30000,'history replayed');await sleep(1000);
 const after=await rp.evaluate(panel,answers) as Answer[];evidence.after=after;
 await rp.screenshot(panel,join(out,'reopened.png'));
 await rp.cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]},panel);await sleep(300);
 await rp.screenshot(panel,join(out,'dark.png'));
 assert.ok(after.some(a=>a.text.startsWith('这副耳机现在卖 ¥999。')&&a.text.includes('更正')&&a.note===null),'answer with appended correction kept after reopening');
 assert.ok(after.at(-1)!.text.startsWith('这副耳机有货，可以直接下单。')&&!after.at(-1)!.text.includes('更正'),'untouched answer stays untouched after reopening');
 await rp.click(panel,'#input');await rp.typeText(panel,'核对验收旧轮');await rp.pressEnter(panel);
 await until(()=>factPrompts.some(p=>p.includes('USER REQUEST: 核对验收旧轮'))||undefined,30000,'old check started');
 await rp.click(panel,'#input');await rp.typeText(panel,'核对验收新轮');await rp.pressEnter(panel);
 await until(()=>rp.evaluate(panel,`document.querySelector('#messages').textContent.includes('这是新任务的回答')`),30000,'new answer');
 await sleep(5000);
 const final=await rp.evaluate(panel,answers) as Answer[];evidence.final=final;
 assert.ok(final.at(-1)?.text.includes('这是新任务的回答'),'late old check cannot replace or correct the new answer');
 assert.ok(final.every(a=>a.note===null),'no diagnostic cards on any answer');
}catch(e){error=e instanceof Error?e.stack??e.message:String(e);if(panel){await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});}}
finally{await writeFile(join(out,'result.json'),JSON.stringify({status:error?'fail':'pass',error,evidence,dependency:'real isolated extension, sidebar and page; local scripted model',requests:model.requests},null,2));await rp.close();await rp.remove();await model.close();await new Promise<void>(r=>site.close(()=>r()));}
console.log(JSON.stringify({status:error?'fail':'pass',error:error.split('\n')[0],out}));if(error)process.exitCode=1;
