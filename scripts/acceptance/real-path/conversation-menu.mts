/** Observable contract: long titles occupy at most two readable lines, update time is visible,
 * selected state/keyboard activation/Escape work, and switching preserves each conversation draft.
 * Real extension + sidepanel; scripted provider only configures the product, no model task is sent. */
import assert from 'node:assert/strict';
import{mkdir,writeFile}from'node:fs/promises';
import{join}from'node:path';
import{REPO,launchRealPath,requireHeadless,until,sleep,type JsonRecord}from'./harness.mts';
import{configureViaSettings}from'./inproc-config.mts';
import{startScriptedModel}from'./scripted-model.mts';

requireHeadless();

const out=join(REPO,'out/acceptance/real-path',new Date().toISOString().replace(/[:.]/g,'-')+'-conversation-menu');

await mkdir(out,{recursive:true});

const model=await startScriptedModel([]),rp=await launchRealPath();

let panel='',failure:string|null=null;

const evidence:JsonRecord={};

const titles=['浏览器扩展的会话恢复与文件核对：在重启之后继续完成原任务并保留草稿','Browser extension memory recovery and independently verifiable file delivery across conversations'];

const rows=()=>rp.evaluate(panel,`[...document.querySelectorAll('#conversation-menu button')].map(e=>({id:e.dataset.conversationId,title:e.title,selected:e.getAttribute('aria-checked'),time:e.querySelector('.conversation-menu-updated')?.textContent,titleHeight:e.querySelector('.conversation-menu-title')?.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(e.querySelector('.conversation-menu-title')).lineHeight),width:e.getBoundingClientRect().width,scrollWidth:e.scrollWidth}))`);

try{
 panel=await rp.attach(await rp.openSidePanel());await until(async()=>(await rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`))||undefined,20000,'侧栏就绪');
 await configureViaSettings(rp,panel,{providerId:'custom',modelId:'demo-model',credential:{type:'api_key',key:'test-key'}},{asCustom:true,baseUrl:model.baseUrl});

 for(const title of titles){await rp.evaluate(panel,`new Promise((resolve,reject)=>{const p=chrome.runtime.connect({name:'sideagent-panel'}),id=crypto.randomUUID();const timer=setTimeout(()=>{p.disconnect();reject(new Error('新会话无回执'));},10000);p.onMessage.addListener(m=>{if(m.kind==='server'&&m.msg.type==='conversation_created'&&m.msg.requestId===id){clearTimeout(timer);p.disconnect();resolve(true);}});p.postMessage({kind:'client',msg:{type:'conversation_create',requestId:id,title:${JSON.stringify(title)}}});})`);}

 await rp.click(panel,'#conversation-switcher');await sleep(200);const list=await rows();evidence.rows=list;

 for(const title of titles){const row=list.find(r=>r.title===title);assert.ok(row);assert.ok(row.time.startsWith('更新于 '));assert.ok(row.titleHeight<=2*row.lineHeight+1,'最多两行');assert.ok(row.scrollWidth<=row.width+1,'无横向溢出');}

 await rp.screenshot(panel,join(out,'menu.png'));
 const a=list.find(r=>r.title===titles[0]),b=list.find(r=>r.title===titles[1]);assert.ok(a&&b);
 await rp.click(panel,`[data-conversation-id="${a.id}"]`);await until(async()=>(await rp.evaluate(panel,`document.querySelector('#input').value`))===''||undefined,5000,'首会话空草稿');await rp.click(panel,'#input');await rp.typeText(panel,'第一会话未发送的草稿');
 await rp.click(panel,'#conversation-switcher');await rp.click(panel,`[data-conversation-id="${b.id}"]`);await until(async()=>(await rp.evaluate(panel,`document.querySelector('#input').value`))===''||undefined,5000,'第二会话没有串草稿');await rp.click(panel,'#input');await rp.typeText(panel,'第二会话草稿');
 await rp.click(panel,'#conversation-switcher');await rp.click(panel,`[data-conversation-id="${a.id}"]`);await until(async()=>(await rp.evaluate(panel,`document.querySelector('#input').value`))==='第一会话未发送的草稿'||undefined,5000,'第一会话草稿恢复');
 await rp.click(panel,'#conversation-switcher');await rp.pressEnter(panel);await until(async()=>(await rp.evaluate(panel,`document.querySelector('#conversation-menu').hidden`))||undefined,5000,'Enter激活并关闭菜单');
 await rp.click(panel,'#conversation-switcher');await rp.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},panel);await rp.cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},panel);assert.equal(await rp.evaluate(panel,`document.querySelector('#conversation-menu').hidden`),true);
 assert.equal(model.requests.filter(r=>r.tools).length,0,'会话切换与键盘操作没有发出模型任务');
 evidence.pass=true;
}catch(e){failure=String(e);evidence.pass=false;evidence.failure=failure;await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});console.error(e);}finally{await writeFile(join(out,'result.json'),JSON.stringify(evidence,null,2));await rp.close();await rp.remove();await model.close();}

console.log(out);

if(failure)process.exitCode=1;
