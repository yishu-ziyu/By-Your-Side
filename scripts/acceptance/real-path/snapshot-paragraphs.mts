/** Real extension and page: spare snapshot space expands paragraphs without evicting controls. */
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,siteAddress,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-snapshot-paragraphs`);await mkdir(out,{recursive:true});
const tail='COMPLETE_PARAGRAPH_EVIDENCE';
const paragraph='This paragraph contains ordinary visible source text. '.repeat(10)+tail;
const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(`<!doctype html><title>Paragraph budget</title><main>${Array.from({length:65},(_,i)=>`<p>Entry ${i}. ${paragraph}</p><button>Choice ${i}</button>`).join('')}<button onclick="document.querySelector('#result').textContent='ACTION_COMPLETED'">Finish budget check</button><p id="result"></p></main>`));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${siteAddress(site).port}/`;
const model=await startScriptedModel([{match:'正文预算验收',steps:[{tool:{name:'browser_run',args:{label:'读取段落并使用末尾控件',code:`const s=await browser.navigate({url:${JSON.stringify(origin)}});if(!s.text.includes(${JSON.stringify(tail)}))throw new Error('Paragraph tail missing');const match=s.text.match(/\\[ref=(\\d+)\\] button "Finish budget check"/);if(!match)throw new Error('End control missing');await browser.click({target:'@'+match[1]});return 'Source and control verified';`}}},{text:'正文预算验收完成。'}]}]);
const rp=await launchRealPath();let error='';let panel='';
try{
 panel=await rp.attach(await rp.openSidePanel());await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
 await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'ready');
 await rp.click(panel,'#input');await rp.typeText(panel,'正文预算验收');await rp.pressEnter(panel);
 const page=await until(async()=> (await rp.targets()).find(t=>t.url===origin),15000,'source page');const session=await rp.attach(page.targetId);
 await until(()=>rp.evaluate(session,`document.querySelector('#result')?.textContent==='ACTION_COMPLETED'`),25000,'visible completion');
 await rp.screenshot(session,join(out,'completed.png'));await rp.screenshot(panel,join(out,'answer.png'));
}catch(e){error=String(e);if(panel){await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});await writeFile(join(out,'failure.txt'),String(await rp.evaluate(panel,'document.body.innerText').catch(String)));}}
finally{await writeFile(join(out,'result.json'),JSON.stringify({status:error?'fail':'pass',error,dependency:'real isolated extension and page; local scripted model',requests:model.requests},null,2));await rp.close();await rp.remove();await model.close();await new Promise<void>(r=>site.close(()=>r()));}
console.log(JSON.stringify({status:error?'fail':'pass',error,out}));if(error)process.exitCode=1;
