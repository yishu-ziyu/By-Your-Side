/**
 * Real extension and page: icon-font glyphs (CSS ::before, Unicode private use) reach the model as [图标], never as text.
 * The page draws five identical star glyphs for a one-star book, so reading the glyphs as text would say "5 stars".
 * Failure: the snapshot passes the glyphs through; the scripted program sees a private-use character and never clicks Done.
 */
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-snapshot-icon-glyphs`);await mkdir(out,{recursive:true});
const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(`<!doctype html><title>Book</title><style>.s::before{content:"\\e006"}</style><main><h1>In Her Wake</h1><p>£12.84</p><p class="star-rating One">${'<i class="s"></i>'.repeat(5)}</p><button onclick="document.querySelector('#result').textContent='GLYPHS_CHECKED'">Done</button><p id="result"></p></main>`));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${siteAddress(site).port}/`;
const toolResults:string[]=[];
const model=await startScriptedModel([{match:'图标字形验收',steps:[{tool:{name:'browser_run',args:{label:'读取评分图标',code:`const s=await browser.navigate({url:${JSON.stringify(origin)}});if(/[\\uE000-\\uF8FF]/.test(s.text))throw new Error('icon glyph reached the model as text');if(!s.text.includes('[图标]'))throw new Error('icon placeholder missing');const match=s.text.match(/\\[ref=(\\d+)\\] button "Done"/);if(!match)throw new Error('Done control missing');await browser.click({target:'@'+match[1]});return 'icons read as icons';`}}},{text:'图标字形验收完成。'}]}],undefined,(payload)=>{
 // SAFETY: the scripted model hands over the product's OpenAI-compatible request body; only tool message texts are read.
 const msgs=(payload as {messages?:Array<{role:string;content?:unknown}>}).messages??[];
 for(const m of msgs)if(m.role==='tool')toolResults.push(typeof m.content==='string'?m.content.slice(0,400):JSON.stringify(m.content).slice(0,400));
});
const rp=await launchRealPath();let error='';let panel='';
try{
 panel=await rp.attach(await rp.openSidePanel());await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
 await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'ready');
 await rp.click(panel,'#input');await rp.typeText(panel,'图标字形验收');await rp.pressEnter(panel);
 const page=await until(async()=> (await rp.targets()).find(t=>t.url===origin),15000,'source page');const session=await rp.attach(page.targetId);
 await until(()=>rp.evaluate(session,`document.querySelector('#result')?.textContent==='GLYPHS_CHECKED'`),25000,'visible completion');
 await rp.screenshot(panel,join(out,'answer.png'));
}catch(e){error=String(e);if(panel){await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});await writeFile(join(out,'failure.txt'),String(await rp.evaluate(panel,'document.body.innerText').catch(String)));}}
finally{await writeFile(join(out,'result.json'),JSON.stringify({status:error?'fail':'pass',error,dependency:'real isolated extension and page; local scripted model',requests:model.requests,toolResults:[...new Set(toolResults)]},null,2));await rp.close();await rp.remove();await model.close();await new Promise<void>(r=>site.close(()=>r()));}
console.log(JSON.stringify({status:error?'fail':'pass',error,out}));if(error)process.exitCode=1;
