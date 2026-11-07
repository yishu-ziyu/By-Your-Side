import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, REPO, requireHeadless, until } from './harness.mts';
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from './inproc-config.mts';

requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-continuous-tasks-live`);
await mkdir(out,{recursive:true});
const plan=await loadModelPlan(DEFAULT_TEST_MODEL);
if(plan.credential.type==='oauth')plan.credential.refresh='';
const rp=await launchRealPath({headed:true});let panel='';let error:string|null=null;let text='';
try{
  panel=await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(()=>true)`);
  await until(async()=>await rp.evaluate(panel,'document.querySelector("#conversation-new")?.getAttribute("aria-busy")==="false" && document.querySelector("#send-btn")?.disabled===false')||undefined,60_000,'侧栏与模型就绪');
  const say=async(s:string)=>{
    await until(async()=>{
      if(await rp.evaluate(panel,'document.activeElement?.id==="input"'))return true;
      await rp.click(panel,'#input');
      return await rp.evaluate(panel,'document.activeElement?.id==="input"')||undefined;
    },5_000,'输入框获得焦点');
    await rp.typeText(panel,s);
    assert.equal(await rp.evaluate(panel,'document.querySelector("#input").value'),s,'输入完整落入输入框');
    await rp.pressEnter(panel);
    await until(async()=>await rp.evaluate(panel,`Array.from(document.querySelectorAll('.msg.user')).some(e=>e.innerText.includes(${JSON.stringify(s)}))`)||undefined,15_000,'用户消息显示在对话中');
    console.log('已发送',s);
  };
  const visible=()=>rp.evaluate(panel,'document.querySelector("#messages").innerText') as Promise<string>;
  await say('打开 https://example.com 和 https://www.iana.org/domains/reserved，比较这两个页面的用途和内容，给出带来源的结论。');
  await until(async()=>await rp.evaluate(panel,'document.querySelector("#status-pill")?.classList.contains("running")')||undefined,30_000,'比较开始');
  await say('另外独立做一件事：打开 https://www.rfc-editor.org/rfc/rfc2606，概括这篇文档。');
  await until(async()=>await rp.evaluate(panel,'Array.from(document.querySelectorAll(".separate-ask")).some(e=>e.innerText.includes("正在做"))')||undefined,90_000,'文档总结独立执行');
  await rp.screenshot(panel,join(out,'parallel.png'));
  await say('比较那件只讲两个页面各自的用途；文档总结那件取消。');
  const answerText = `(() => { const turn=Array.from(document.querySelectorAll('.msg.user')).findLast(e=>e.innerText.includes('比较那件只讲两个页面各自的用途')); return Array.from(document.querySelectorAll('.msg.assistant')).filter(e=>turn && (turn.compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING)).map(e=>e.innerText).join(' '); })()`;
  let calm = 0;
  await until(async()=>{
    const s=await visible(),answer=String(await rp.evaluate(panel,answerText));
    const complete=/已取消|已终止/.test(s)&&/example\.com|Example Domain/i.test(answer)&&/iana|保留域名/i.test(answer)
      &&await rp.evaluate(panel,'!document.querySelector("#send-btn")?.classList.contains("stopping") && !document.querySelector("#status-pill")?.classList.contains("running")');
    calm=complete?calm+1:0;return calm>=3||undefined;
  },180_000,'修改后的比较结果交付且续做已结束',500);
  text=await visible();
  const answer=String(await rp.evaluate(panel,answerText));
  assert.match(answer,/example\.com|Example Domain/i,'比较回答涉及 example.com');
  assert.match(answer,/iana|保留域名/i,'比较回答涉及 IANA');
  assert.match(answer,/示例|例子|示范|example/i,'说明示例页面用途');
  assert.match(answer,/用途|保留|reserved/i,'说明页面用途');
  assert.ok(await rp.evaluate(panel,'Array.from(document.querySelectorAll(".separate-ask")).some(e=>e.innerText.includes("已取消"))'),'总结原位显示已取消');
  await rp.screenshot(panel,join(out,'result.png'));
  await rp.cdp.send('Page.reload',{},panel);
  await until(async()=>await rp.evaluate(panel,'document.querySelector("#send-btn")?.disabled===false')||undefined,30_000,'侧栏重开');
  assert.ok((await visible()).includes('已取消'),'重开后取消状态保留');
  await rp.screenshot(panel,join(out,'reopened.png'));
}catch(e){error=e instanceof Error?e.message:String(e);if(panel){text=String(await rp.evaluate(panel,'document.querySelector("#messages")?.innerText??""').catch(()=>''));await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{})}}
finally{if(panel)await rp.evaluate(panel,`chrome.storage.local.remove(${JSON.stringify(`inproc_cred:${plan.providerId}`)}).then(()=>true)`).catch(()=>{});await rp.close();await rp.remove();}
await writeFile(join(out,'result.json'),JSON.stringify({status:error?'FAIL':'PASS',model:DEFAULT_TEST_MODEL,error,text},null,2),{mode:0o600});
console.log(JSON.stringify({status:error?'FAIL':'PASS',out,error}));if(error)process.exitCode=1;
