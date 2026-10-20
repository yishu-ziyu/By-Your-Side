import { useSavedSettingsModel } from './inproc-config.mts';
import type { TranslationCommand } from '../../../shared/page-translation.js';
/** Real extension, native page/panel renderer targets; no visible Chrome window.
 *   npx tsx scripts/acceptance/real-path/killer-interactions.mts --headless --run=final
 * Translation batches come from a fixture, so this does not measure provider translation quality. */
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, REPO, siteAddress, until, sleep, type Json } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();

const run = process.argv.find(arg=>arg.startsWith('--run='))?.slice(6) ?? 'candidate';

if (!/^[a-z0-9-]+$/.test(run)) throw Error('invalid run');

const out=join(REPO,'out/acceptance/killer-interactions',run);

await mkdir(out,{recursive:true});

const html=`<!doctype html><meta charset="utf-8"><title>来源验收</title><style>body{margin:60px;font:18px/1.6 sans-serif}section{min-height:650px}table{width:600px}td{padding:16px}pre{padding:24px;background:#eee}</style>
<section><div id="dark-header" style="display:flex;align-items:center;gap:16px;padding:10px 16px;background:#24292f;color:#fff">
  <strong>GitHub Gist</strong>
  <a id="nav-all" href="#all" style="color:#fff;text-decoration:none">All gists</a>
  <a id="nav-back" href="#back" style="color:#fff;text-decoration:none">Back to GitHub</a>
</div><h2>第一节</h2><p id="original">All webhook events are signed using a cryptographic signature with timestamp replay prevention.</p><div id="mixed">Parent text<p id="child">Child paragraph</p>Tail text</div><table aria-label="资产负债表 Q3"><tr><td>毛利率</td><td>62.4%</td></tr><tr><td>研发支出</td><td>4,120M</td></tr></table></section>
<section id="section-two"><h2>第二节</h2><p>第二节讨论流动比率与资本开支。</p><pre>const revenue = 8940;</pre></section><section><h2>第三节</h2><p>第三节讨论重复数字。未知值不得制造引用。</p></section>`;

const site=createServer((_q,r)=>r.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end(html));

await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));

const origin=`http://127.0.0.1:${siteAddress(site).port}`;

const receivedMessages: string[] = [];

const model=await startScriptedModel([{match:'来源验收',steps:[{text:'毛利率为62.4%，研发支出4,120M。未知比率为99.99%。'}]},{match:'边注解释',steps:[{text:'这段介绍了当前阅读的主题，并指出来源中的关键信息。',delayMs:500}]}],undefined,payload=>{if(payload.tools?.length)receivedMessages.push(JSON.stringify(payload.messages));});

const rp=await launchRealPath();

const checks:Array<{name:string;pass:boolean;actual:Json}>=[];

const check=(name:string,pass:boolean,actual:Json)=>{checks.push({name,pass,actual});console.log(`${pass?'PASS':'FAIL'} ${name}`,JSON.stringify(actual));};

try {
  const work=await rp.attach((await rp.targets()).find(t=>t.url==='about:blank')!.targetId);
  await rp.cdp.send('Page.navigate',{url:origin},work);
  await until(async()=>await rp.evaluate(work,'!!document.querySelector("[data-sideagent-ask]")'),10000,'content script');
  const panel=await rp.attach(await rp.openSidePanel());
  await rp.cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true},panel);
  await until(async()=>await rp.evaluate(panel,'document.querySelector("#conversation-new")?.disabled===false'),60000,'panel ready');
  const worker=await rp.attach((await rp.serviceWorker())!.targetId);
  const tabId=await rp.evaluate(worker,`chrome.tabs.query({}).then(ts=>ts.find(t=>t.url.startsWith(${JSON.stringify(origin)})).id)`);
  const compiled = await transform(await readFile(join(REPO,'extension/src/shared/page-translation.ts'),'utf8'),{loader:'ts',format:'iife',globalName:'TranslationAPI'});
  await rp.evaluate(worker,compiled.code+';globalThis.__translationAcceptance=TranslationAPI.translationInPage');
  const observationSource=await readFile(join(REPO,'extension/src/background/exec/snapshot.ts'),'utf8');
  const oracle=await transform(observationSource.slice(observationSource.indexOf('export function readTranslationDisplay()')),{loader:'ts',format:'iife',globalName:'DisplayAPI'});
  await rp.evaluate(worker,oracle.code+';globalThis.__translationDisplayAcceptance=DisplayAPI.readTranslationDisplay');
  await rp.evaluate(work,'window.originalNode=document.querySelector("#original").firstChild;window.originalText=originalNode.data;window.originalClicks=0;document.querySelector("#original").onclick=()=>window.originalClicks++;window.headerHeightBefore=document.querySelector("#dark-header").offsetHeight');
  const command=async(value:TranslationCommand)=>rp.evaluate(worker,`chrome.scripting.executeScript({target:{tabId:${tabId}},world:'ISOLATED',func:globalThis.__translationAcceptance,args:[${JSON.stringify(value)}]}).then(rs=>rs[0].result)`);
  await command({action:'begin',mode:'translated',fontFamily:'songti'});
  const collected=await command({action:'collect'});
  const originals=collected.blocks;
  const translations=originals.flatMap((block:any)=>block.segments.map((segment:any)=>({id:segment.id,text:segment.text.includes('webhook')?'所有Webhook事件使用带时间戳的加密签名。':segment.text.includes('All gists')?'所有 Gist':segment.text.includes('Back to GitHub')?'返回 GitHub':segment.text.includes('Parent')?'父级译文':segment.text.includes('Child')?'子段落译文':segment.text.includes('Tail')?'尾部译文':segment.text})));
  const appliedReceipt=await command({action:'apply',document:collected.document,translations});
  await command({action:'settle',document:collected.document});
  const displayed=await rp.evaluate(worker,`chrome.scripting.executeScript({target:{tabId:${tabId}},world:'ISOLATED',func:globalThis.__translationDisplayAcceptance}).then(rs=>rs[0].result)`);
  check('生产显示核验观察真实译文与字体',displayed?.displayValid===true&&displayed?.translated===8&&displayed?.mode==='translated'&&displayed?.fontFamily==='songti'&&appliedReceipt?.fontFamily==='songti',{displayed,fontFamily:appliedReceipt?.fontFamily});
  const replacedInPlace=await rp.evaluate(work,'originalNode.isConnected && originalNode.data==="所有Webhook事件使用带时间戳的加密签名。" && !document.querySelector(".vellum-sheet") && !document.querySelector("[data-bys-vellum-host]")');
  check('仅译文原地替换原节点文字且无硫酸纸层',replacedInPlace,replacedInPlace);
  const darkHeaderIntact=await rp.evaluate(work,'(()=>{const h=document.querySelector("#dark-header"),a=document.querySelector("#nav-all");return{heightDelta:Math.abs(h.offsetHeight-window.headerHeightBefore),text:a.textContent,color:getComputedStyle(a).color,bg:getComputedStyle(h).backgroundColor}})()');
  check('深色顶栏译文保持原高度与白字配色',darkHeaderIntact.heightDelta<=2&&darkHeaderIntact.text==='所有 Gist'&&darkHeaderIntact.color==='rgb(255, 255, 255)',darkHeaderIntact);
  await rp.screenshot(work,join(out,'translated-in-place.png'));

  const nested=await rp.evaluate(work,'(()=>{const c=document.querySelector("#child");if(!c)return null;const r=c.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{visible:!!hit&&(hit===c||c.contains(hit)),text:c.textContent,mixedText:document.querySelector("#mixed")?.textContent}})()');
  check('嵌套子段落译文未被父层遮挡',nested?.visible&&nested.text==='子段落译文'&&nested.mixedText?.includes('父级译文')&&nested.mixedText?.includes('尾部译文'),nested);
  await rp.evaluate(work,'originalNode.data="Website updated source";document.querySelector("#original").style.paddingBottom="33px";const extra=document.createElement("em");extra.id="site-new";extra.textContent="Site added";document.querySelector("#mixed").append(extra)');
  await sleep(100);
  check('网页更新不被旧译文或清理覆盖',await rp.evaluate(work,'originalNode.data==="Website updated source" && document.querySelector("#original").style.paddingBottom==="33px" && !!document.querySelector("#mixed #site-new")'),null);
  await command({action:'restore'});
  check('恢复原文且保留网站后续更新',await rp.evaluate(work,'!document.querySelector(".vellum-sheet") && originalNode.data==="Website updated source" && document.querySelector("#child").textContent==="Child paragraph" && !document.querySelector("#child").getAttribute("style")'),null);
  await rp.click(work,'#original');
  check('原节点事件仍可用',await rp.evaluate(work,'originalClicks===1'),null);

  await rp.click(panel,'#header-more');await rp.click(panel,'#model-settings-open');
  const settings=await rp.attach((await until(async()=>(await rp.targets()).find(t=>t.url.split("#")[0]!.endsWith('/settings.html')),10000,'settings')).targetId);
  await until(async()=>await rp.evaluate(settings,'document.querySelectorAll(".provider-option").length>3'),10000,'providers');
  await rp.click(settings, '[data-settings-page="connections"]');
  await rp.evaluate(settings,'document.querySelector("#provider-more").open=true');
  await rp.click(settings,'.provider-option[data-provider="custom"]');

  for(const [selector,value] of [['#base-url',model.baseUrl],['#api-key','local-fixture'],['#model-id','fixture']]){
    await rp.evaluate(settings,`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView();e.focus();e.select()})()`);await rp.typeText(settings,value);
  }

  await rp.evaluate(settings,'document.querySelector("#model-save").scrollIntoView()');await rp.click(settings,'#model-save');
  await until(async()=>String(await rp.evaluate(settings,'document.querySelector("#model-status").textContent')).startsWith('已保存'),10000,'saved');
  await useSavedSettingsModel(rp, settings, 'custom', 'fixture');
  await rp.cdp.send('Target.closeTarget',{targetId:(await rp.targets()).find(t=>t.url.split("#")[0]!.endsWith('/settings.html'))!.targetId});
  await rp.click(panel,'#input');await rp.typeText(panel,'来源验收');await rp.pressEnter(panel);
  await until(async()=>await rp.evaluate(panel,'!!document.querySelector(".answer-actions")'),30000,'answer');await sleep(500);
  const citations=await rp.evaluate(panel,'Array.from(document.querySelectorAll(".num-cite")).map(b=>b.textContent)');
  check('有据数字生成引用、未知数字不生成',citations.length===2&&citations.some((s:string)=>s.includes('62.4%'))&&!citations.some((s:string)=>s.includes('99.99%')),citations);

  // 声纳圈在 closed shadow 里：用 CDP 穿透读出圈的路径，看它是否圈住真实数据格。
  const circle=async()=>{
    const {root}=await rp.cdp.send('DOM.getDocument',{depth:-1,pierce:true},work);

    const walk=(n:any,inSonar:boolean):string|null=>{
      const here=inSonar||(n.attributes??[]).join(' ').includes('data-sideagent-overlay sonar');

      if(here&&n.nodeName==='path')return n.attributes[n.attributes.indexOf('d')+1];

      for(const c of [...(n.shadowRoots??[]),...(n.children??[])]){
        const d=walk(c,here);

        if(d)return d;
      }

      return null;
    };

    const d=walk(root,false);

    if(!d)return null;

    const xy=(d.match(/-?[\d.]+/g)??[]).map(Number);
    const xs=xy.filter((_,i)=>i%2===0),ys=xy.filter((_,i)=>i%2===1);

    return {left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys)};
  };

  if(citations.length){
    const cell='(()=>{const td=[...document.querySelectorAll("td")].find(t=>t.textContent==="62.4%"),r=td.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()';
    const pageMarks='document.querySelectorAll("[class*=bys-sonar],style").length';
    const marksBefore=await rp.evaluate(work,pageMarks);
    await rp.evaluate(work,'scrollTo(0,1500)');await rp.click(panel,'.num-cite');await sleep(1000);
    const box=await circle();const center=await rp.evaluate(work,cell);
    check('手绘圈圈住真实数据格',!!box&&box.left<center.x&&center.x<box.right&&box.top<center.y&&center.y<box.bottom,{box,center});
    check('声纳不改页面 DOM',await rp.evaluate(work,pageMarks)===marksBefore,null);
    await rp.screenshot(work,join(out,'sonar.png'));await sleep(1300);
    check('声纳 1.8 秒后淡出清理',await circle()===null,null);
    await rp.click(panel,'.num-cite');await sleep(1850);await rp.click(panel,'.num-cite');await sleep(450);
    check('淡出途中再点，新圈不被旧圈的清理带走',await circle()!==null,null);
    await sleep(2000);
  }

  const aiBefore=model.requests.filter(r=>r.rule==='边注解释').length;
  await rp.evaluate(panel,`document.querySelector('#marginalia-mode').value='source';document.querySelector('#marginalia-mode').dispatchEvent(new Event('change'));`);
  await rp.evaluate(work,'scrollTo(0,0)');await sleep(400);
  const first=await rp.evaluate(panel,'document.querySelector(".marginalia-card")?.textContent');
  await rp.evaluate(work,'scrollTo(0,800)');await sleep(500);
  const second=await rp.evaluate(panel,'document.querySelector(".marginalia-card")?.textContent');
  check('滚动切换真实原文边注',!!first&&!!second&&first!==second,{first,second});
  const alignment=await rp.evaluate(panel,'(()=>{const rail=document.querySelector("#marginalia-rail"),card=document.querySelector(".marginalia-card"),r=card.getBoundingClientRect(),frame=document.querySelector("#messages-frame")??document.querySelector("#messages");return {railHeight:rail.clientHeight,railTop:rail.getBoundingClientRect().top,cardHeight:card.offsetHeight,pageY:rail.dataset.pageY,pageHeight:rail.dataset.pageHeight,panelHeight:innerHeight,panelOuter:outerHeight,panelScreen:screenY,cardCenter:r.y+r.height/2,transform:getComputedStyle(card).transform,messagesHidden:getComputedStyle(frame).display==="none"}})()');
  check('伴读使用阅读区导轨且对话保留',alignment.railHeight>172&&alignment.messagesHidden,alignment);
  const sourceLine=await rp.evaluate(work,'(()=>{const r=document.querySelector("#section-two").getBoundingClientRect();return screenY+outerHeight-innerHeight+(r.top+r.bottom)/2})()');
  const panelLine=await rp.evaluate(panel,'(()=>{const r=document.querySelector(".marginalia-card").getBoundingClientRect();return screenY+outerHeight-innerHeight+(r.top+r.bottom)/2})()');
  check('边注中心与真实段落水平对齐',Math.abs(sourceLine-panelLine)<=2,{sourceLine,panelLine});
  await rp.screenshot(panel,join(out,'marginalia.png'));
  check('原文模式不调用模型',model.requests.filter(r=>r.rule==='边注解释').length===aiBefore,null);
  await rp.evaluate(panel,`document.querySelector('#marginalia-mode').value='ai';document.querySelector('#marginalia-mode').dispatchEvent(new Event('change'));`);
  await until(async()=>await rp.evaluate(panel,'document.querySelector(".marginalia-card").dataset.state==="done"'),30000,'AI边注');
  const ai=await rp.evaluate(panel,'document.querySelector(".marginalia-card").textContent');
  check('可选择AI模式且解释来自实际模型',ai.includes('这段介绍')&&model.requests.some(r=>r.rule==='边注解释'),ai);
  await rp.evaluate(panel,`document.querySelector('#marginalia-mode').value='off';document.querySelector('#marginalia-mode').dispatchEvent(new Event('change'));`);
  const beforeOff=model.requests.filter(r=>r.rule==='边注解释').length;
  await rp.evaluate(work,'scrollTo(0,1400)');await sleep(700);
  check('关闭模式滚动不产生新解释',model.requests.filter(r=>r.rule==='边注解释').length===beforeOff,null);
  check('关闭边注隐藏导轨',await rp.evaluate(panel,'document.querySelector("#marginalia-rail").hidden'),null);

  await rp.evaluate(work,'document.querySelector("table tr td:last-child").textContent="162.4%"');
  const partial=await rp.evaluate(panel,`(async()=>{const identity=await chrome.runtime.sendMessage({type:'PINPOINT_DOM_TARGET',action:'identity',tabId:${tabId},url:${JSON.stringify(origin+'/')}});return chrome.runtime.sendMessage({type:'PINPOINT_DOM_TARGET',action:'resolve',query:'62.4%',tabId:${tabId},...identity});})()`);
  check('不把62.4%误匹配到162.4%',partial.ok===false,partial);
  await rp.click(panel,'.num-cite');await sleep(200);
  check('原文改写后旧引用拒绝定位',await circle()===null,null);
  await rp.evaluate(work,'document.querySelector("table tr td:last-child").textContent="62.4%"');
  await rp.evaluate(work,'scrollTo(0,0)');await sleep(300);
  // 表格本身不再可拖：悬停表格，从左上角把手拖整张表。
  const showGrip=async()=>{const cell=await rp.evaluate(work,'(()=>{const r=document.querySelector("table td").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');await rp.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...cell,button:'none',buttons:0},work);await sleep(300);};

  await showGrip();
  const dragPoint=await rp.evaluate(work,'(()=>{const r=document.querySelector("[data-bys-feed-grip]").shadowRoot.querySelector(".grip").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
  const drag=rp.cdp.waitForEvent('Input.dragIntercepted',5000);
  await rp.cdp.send('Input.setInterceptDrags',{enabled:true},work);
  await rp.cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...dragPoint,button:'left',clickCount:1},work);
  await rp.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragPoint.x+100,y:dragPoint.y+30,button:'left',buttons:1},work);

  try {
    const data=(await drag).params.data;
    const dropPoint=await rp.evaluate(panel,'(()=>{const r=document.querySelector("#composer").getBoundingClientRect();return{x:r.x+40,y:r.y+40}})()');

    for(const type of ['dragEnter','dragOver'])await rp.cdp.send('Input.dispatchDragEvent',{type,...dropPoint,data},panel);
    check('拖入显示磁吸槽',await rp.evaluate(panel,'document.querySelector("#composer").classList.contains("dropzone-hover")'),null);
    await rp.cdp.send('Input.dispatchDragEvent',{type:'drop',...dropPoint,data},panel);
    await rp.cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...dragPoint,button:'left',clickCount:1},work);
    await sleep(300);
    const feed=await rp.evaluate(panel,'({text:document.querySelector("#ask-cite-text").textContent,input:document.querySelector("#input").value,visible:!document.querySelector("#ask-cite").hidden})');
    check('真实拖拽生成材料和草稿',feed.visible&&feed.input.includes('表格'),feed);
    await rp.screenshot(panel,join(out,'feed.png'));
    const requestCount=model.requests.length;
    await sleep(300);check('投喂不自动调用模型',model.requests.length===requestCount,model.requests.length);


    if(process.argv.includes('--feed=remove')) {
      await rp.click(panel,'#ask-cite-close');
      check('移除投喂保留正文',await rp.evaluate(panel,'document.querySelector("#input").value.length>0 && document.querySelector("#ask-cite").hidden'),null);
    } else {
      await rp.click(panel,'#ask-cite-close');
      check('移除投喂保留正文',await rp.evaluate(panel,'document.querySelector("#input").value.length>0 && document.querySelector("#ask-cite").hidden'),null);
      await rp.cdp.send('Input.dispatchDragEvent',{type:'dragCancel',...dragPoint,data},work);
      await rp.cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...dragPoint,button:'left',clickCount:1},work);
      await showGrip();
      const again=rp.cdp.waitForEvent('Input.dragIntercepted',5000);
      await rp.cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...dragPoint,button:'left',clickCount:1},work);
      await rp.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragPoint.x+100,y:dragPoint.y+30,button:'left',buttons:1},work);
      const dataAgain=(await again).params.data;


      for(const type of ['dragEnter','dragOver','drop'])await rp.cdp.send('Input.dispatchDragEvent',{type,...dropPoint,data:dataAgain},panel);
      await sleep(300);
      await rp.evaluate(panel,`document.querySelector('#marginalia-mode').value='source';document.querySelector('#marginalia-mode').dispatchEvent(new Event('change'));`);
      await rp.click(panel,'#input');await rp.pressEnter(panel);
      check('发送提问返回对话且保留会话',await rp.evaluate(panel,'document.querySelector("#marginalia-mode").value==="off" && getComputedStyle(document.querySelector("#messages")).display!=="none"'),null);
    await until(async()=>receivedMessages.some(text=>text.includes('毛利率 | 62.4%')&&text.includes('研发支出 | 4,120M')),10000,'模型收到表格材料');
    check('发送时模型收到真实结构化表格',true,{containsRows:true});
    }
  }catch(error){check('原生拖拽链路',false,String(error));}

  await rp.cdp.send('Page.navigate',{url:origin+'/replacement'},work);
  await until(async()=>await rp.evaluate(work,'!!document.querySelector("[data-sideagent-ask]")'),10000,'new document');
  await rp.evaluate(panel,`document.querySelector('.num-cite')?.scrollIntoView({block:'center'})`);
  await rp.click(panel,'.num-cite');await sleep(200);
  const old=await rp.evaluate(panel,`!!document.querySelector('.source-toast')`);
  check('导航后不把旧回答绑定到新页',old,null);
} finally {
  await writeFile(join(out,'result.json'),JSON.stringify({checks,notCovered:['操作系统跨窗口手感','供应商模型引用正确率'],modelRequests:model.requests},null,2));
  await rp.close();await rp.remove();await model.close();await new Promise<void>(r=>site.close(()=>r()));
}

if(checks.some(c=>!c.pass))process.exitCode=1;
