/**
 * 真实扩展 + ChatGPT 登录模型：离散档位滑块、实际自动升档、按模型保存、重开与双窗口。
 * npx tsx scripts/acceptance/real-path/model-menu.mts --headless
 * 不用伪造模型事件判通过：实际请求中的 effort 与界面显示相互核对。
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,until,sleep,siteAddress,exportDiagnosticsViaSettings} from './harness.mts';
import {loadModelPlan,modelStorageItems,DEFAULT_TEST_MODEL} from './inproc-config.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-model-menu`);
await mkdir(out,{recursive:true});
const plan=await loadModelPlan(DEFAULT_TEST_MODEL);
const site=createServer((_q,r)=>r.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end('<!doctype html><title>团队周报</title><h1>团队周报</h1><p>完成12项，延期2项。负责人：李雷。</p>'));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const rp=await launchRealPath();let panel='',panelTarget='',error:string|null=null;const evidence:Record<string,unknown>={};
const chip=()=>rp.evaluate(panel,'document.querySelector("#think-chip")?.innerText') as Promise<string>;
const menuOpen=()=>rp.evaluate(panel,'document.querySelector("#think-menu")?.classList.contains("open")') as Promise<boolean>;
const key=async(k:string)=>{for(const type of ['keyDown','keyUp'])await rp.cdp.send('Input.dispatchKeyEvent',{type,key:k,code:k},panel);};
const openMenu=async()=>{if(!await menuOpen())await rp.click(panel,'#think-chip');await until(async()=>await rp.evaluate(panel,'!!document.querySelector(".mm-power-slider input")')||undefined,5000,'滑块出现');await sleep(350);};
const pick=async(_index:number,label:string)=>{
  await openMenu();await rp.click(panel,'.mm-power-slider input');await key('Home');
  for(let i=0;i<8;i++){
    const value=String(await rp.evaluate(panel,'document.querySelector(".mm-power-slider input")?.getAttribute("aria-valuetext")'));
    if(value.startsWith(label+' '))break;
    await key('ArrowRight');
    await until(async()=>String(await rp.evaluate(panel,'document.querySelector(".mm-power-slider input")?.getAttribute("aria-valuetext")'))!==value||undefined,5000,'逐档切换');
  }
  await until(async()=>new RegExp('·\\s*'+label+'$').test(String(await chip()).trim())||undefined,5000,'宿主确认档位');
  assert.ok(await menuOpen(),'选档后菜单仍打开');await rp.screenshot(panel,join(out,`level-${label}.png`));await key('Escape');
};
const ask=async(text:string)=>{await rp.click(panel,'#input');await rp.typeText(panel,text);await rp.pressEnter(panel);};
const idle=()=>rp.evaluate(panel,'!document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")') as Promise<boolean>;
const openPanel=async()=>{panelTarget=await rp.openSidePanel();panel=await rp.attach(panelTarget);await rp.cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true},panel);await until(async()=>await rp.evaluate(panel,'document.querySelector("#send-btn")?.disabled===false')||undefined,60000,'侧栏就绪');};
try{
  const work=await rp.attach((await rp.targets()).find(t=>t.url==='about:blank')!.targetId);
  await rp.cdp.send('Page.navigate',{url:`http://127.0.0.1:${siteAddress(site).port}`},work);
  await openPanel();await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))})`);
  await until(async()=>String(await chip()).includes('Luna')||undefined,60000,'模型已加载');
  await openMenu();evidence.slider=await rp.evaluate(panel,'({max:document.querySelector(".mm-power-slider input").max,actual:document.querySelector(".mm-power-level").textContent,note:document.querySelector(".mm-power-note").textContent})');
  assert.ok(Number((evidence.slider as {max:string}).max)>=3,'支持的中间档位都可选');
  await key('Escape');console.log('验证中档真实请求');await pick(1,'中');await ask('这页的负责人是谁？只回答姓名。');
  await until(async()=>String(await rp.evaluate(panel,'document.querySelector("#messages")?.innerText')).includes('李雷')&&await idle()||undefined,90000,'中档真实回答');
  evidence.medium=await chip();
  console.log('验证自动升档');await pick(0,'低');await ask('请读当前周报，先分析每个数字，再用800字解释项目管理风险。');
  await until(async()=>await rp.evaluate(panel,'document.querySelector("#status-pill")?.classList.contains("running")')||undefined,10000,'原任务正在执行');
  await ask('不对，不要长文，直接说延期数量。');
  await until(async()=>/·\s*中/.test(await chip())||undefined,20000,'实际自动升到中档');
  await openMenu();evidence.raised=await rp.evaluate(panel,'({chip:document.querySelector("#think-chip").innerText,note:document.querySelector(".mm-power-note").textContent})');
  assert.match((evidence.raised as {note:string}).note,/从低自动升至中/,'说明起始档与实际档');
  await rp.screenshot(panel,join(out,'auto-raised.png'));await key('Escape');
  await until(async()=>await idle()||undefined,90000,'纠正后的回答结束');
  console.log('验证双窗口与重开');const otherWindow=Number(await rp.evaluate(panel,`chrome.windows.create({url:'http://127.0.0.1:${siteAddress(site).port}',focused:false}).then(w=>w.id)`));
  await rp.evaluate(panel,`chrome.sidePanel.open({windowId:${otherWindow}})`,{userGesture:true});
  await until(async()=>(await rp.targets()).filter(t=>t.type==='page'&&t.url.endsWith('/sidepanel.html')).length>=2||undefined,10000,'两个窗口侧栏');
  await sleep(1000);assert.match(await chip(),/·\s*中/,'另一面板恢复设置不能重置自动升档');
  await rp.evaluate(panel,`chrome.windows.remove(${otherWindow})`);
  await rp.cdp.send('Target.closeTarget',{targetId:panelTarget});await openPanel();
  await until(async()=>/·\s*中/.test(await chip())||undefined,10000,'重开仍显示实际档位');evidence.reopened=await chip();
  await openMenu();await rp.click(panel,'.mm-model-link');await sleep(350);
  await until(async()=>await rp.evaluate(panel,'document.querySelector("#think-menu")?.classList.contains("mm-in-all")')||undefined,5000,'模型列表');
  await rp.typeText(panel,'sol');await sleep(200);
  const candidate=await rp.evaluate(panel,`[...document.querySelectorAll('.mm-all .mm-row[data-model]')].map(e=>e.dataset.model).find(id=>id.startsWith('openai-codex/')&&id!==${JSON.stringify(DEFAULT_TEST_MODEL)})`) as string|undefined;
  assert.ok(candidate,'同账号可切换的模型');evidence.candidate=candidate;console.log('切换模型',candidate);await rp.click(panel,`.mm-all .mm-row[data-model="${candidate}"]`);
  await until(async()=>!String(await chip()).includes('Luna')||undefined,15000,'换模型');
  await pick(2,'高');await openMenu();await rp.click(panel,'.mm-model-link');await sleep(350);await rp.typeText(panel,'luna');await sleep(200);await rp.click(panel,`.mm-all .mm-row[data-model="${DEFAULT_TEST_MODEL}"]`);
  await until(async()=>/Luna/.test(await chip())&&/·\s*低/.test(await chip())||undefined,15000,'原模型保留手动低档，切换后重置自动档');evidence.perModel=await chip();
  await openMenu();await rp.cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'},{name:'prefers-reduced-motion',value:'reduce'}]},panel);await rp.screenshot(panel,join(out,'dark-reduced.png'));
  await rp.cdp.send('Emulation.setEmulatedMedia',{features:[]},panel);await rp.screenshot(panel,join(out,'slider.png'));
  const exported=await exportDiagnosticsViaSettings(rp,rp.extensionId,join(out,'downloads'));
  const traces=exported.traces.split('\n').filter(Boolean).map(line=>JSON.parse(line));
  evidence.effortChanges=traces.filter(t=>t.type==='effort_change');
  evidence.modelEfforts=traces.filter(t=>t.type==='model_request').map(t=>({time:t.time,runId:t.runId,effort:t.data.effort}));
  assert.ok((evidence.modelEfforts as {effort:string}[]).some(t=>t.effort==='medium'),'真实请求使用中档');
  assert.ok((evidence.effortChanges as {data:{signal:string;from:string;to:string}}[]).some(t=>t.data.signal==='user_correction'&&t.data.from==='low'&&t.data.to==='medium'),'真实纠正触发升档，不是只改显示');
}catch(e){error=String(e instanceof Error?e.stack:e);if(panel){evidence.failureView=await rp.evaluate(panel,'({text:document.body.innerText,menu:document.querySelector("#think-menu")?.outerHTML})').catch(()=>null);await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});await exportDiagnosticsViaSettings(rp,rp.extensionId,join(out,'failure-downloads')).catch(()=>{});}}finally{await writeFile(join(out,'result.json'),JSON.stringify({status:error?'FAIL':'PASS',evidence,error},null,2));await rp.close();await rp.remove();site.closeAllConnections();site.close();}
console.log(JSON.stringify({status:error?'FAIL':'PASS',out,evidence,error},null,2));if(error)process.exitCode=1;
