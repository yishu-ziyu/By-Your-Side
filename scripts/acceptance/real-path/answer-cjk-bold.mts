/**
 * Real extension: bold and italic whose text starts or ends with Chinese punctuation render as bold/italic in the
 * answer, with no stray asterisks — e.g. "**简单选法：**想理解", "是**「这个」**吧", "**价格（含税）**是".
 * Plain cases ("**注意**：", "**Note:** ok") and a literal "a * b" stay as before.
 *   npx tsx scripts/acceptance/real-path/answer-cjk-bold.mts --headless
 * The model is scripted (it returns the Markdown), so this proves the panel layer.
 */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {REPO,launchRealPath,requireHeadless,sleep,until} from './harness.mts';
import {startScriptedModel} from './scripted-model.mts';
requireHeadless();
const out=join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-answer-cjk-bold`);
await mkdir(out,{recursive:true});
const task='粗体验收：给我三个资料站的简单选法。';
const answer=['**简单选法：**想理解原理先看 Laws of UX。','是**「这个」**吧，*斜体：*也行。','**价格（含税）**是 30 元，**注意**：别算错，**Note:** ok，a * b * c。'].join('\n\n');
const WANT={strong:['简单选法：','「这个」','价格（含税）','注意','Note:'],em:['斜体：']};
const model=await startScriptedModel([{match:task,steps:[{text:answer}]}]);
const rp=await launchRealPath();let panel='',seen:{text:string;strong:string[];em:string[]}|undefined,error='';
try{
 panel=await rp.attach(await rp.openSidePanel());
 await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({inproc_model_config:{provider:'custom',modelId:'fixture',baseUrl:model.baseUrl},'inproc_cred:custom':{type:'api_key',key:'local-fixture'}})}).then(()=>true)`);
 await until(()=>rp.evaluate(panel,`document.querySelector('#send-btn')?.disabled===false`),60000,'sidebar ready');
 await rp.click(panel,'#input');await rp.typeText(panel,task);await rp.pressEnter(panel);
 seen=await until(async()=>(await rp.evaluate(panel,`(()=>{const a=[...document.querySelectorAll('.msg.assistant')].at(-1);if(!a||!a.innerText.includes('a * b * c'))return null;return {text:a.innerText,strong:[...a.querySelectorAll('strong')].map(e=>e.innerText),em:[...a.querySelectorAll('em')].map(e=>e.innerText)}})()`)) as typeof seen??undefined,60000,'answer rendered');
 await sleep(1500);await rp.screenshot(panel,join(out,'panel.png'));
 for(const s of WANT.strong)assert.ok(seen!.strong.includes(s),`bold: ${s}`);
 for(const s of WANT.em)assert.ok(seen!.em.includes(s),`italic: ${s}`);
 assert.ok(!seen!.text.includes('**')&&!/\*[^ ]/.test(seen!.text.replace('a * b * c','')),'no stray asterisks');
}catch(e){error=String(e).split('\n')[0];if(panel)await rp.screenshot(panel,join(out,'failure.png')).catch(()=>{});}
finally{await rp.close();await rp.remove();await model.close();}
const status=error?'fail':'pass';
await writeFile(join(out,'result.json'),JSON.stringify({status,error,seen,dependency:'real isolated extension; scripted model returning Markdown'},null,2));
console.log(JSON.stringify({status,error,seen,out}));
if(error)process.exitCode=1;
