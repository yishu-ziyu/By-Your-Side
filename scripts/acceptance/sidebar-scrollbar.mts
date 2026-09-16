import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {launchIsolatedExtension,until} from './isolated-extension.mts';
if(!process.argv.includes('--headless'))throw Error('Required --headless');
const out=resolve('docs/evals/20260916-page-translation-failure');await mkdir(out,{recursive:true});
const iso=await launchIsolatedExtension();
try{
 const id=await iso.swEval('chrome.runtime.id');const panel=await iso.newTarget(`chrome-extension://${id}/sidepanel.html`);
 await until(async()=>await iso.evalIn(panel,"!!document.querySelector('#messages')")||undefined,5000,'panel ready');
 await until(async()=>await iso.evalIn(panel,"document.querySelector('#status-text')?.textContent==='未连接'")||undefined,10000,'stable disconnected panel');
 await iso.evalIn(panel,`(()=>{document.querySelector('#setup').style.display='none';document.querySelector('#messages').style.display='flex';document.querySelector('#messages').innerHTML='<details open class="thinking streaming"><summary>正在思考…</summary><pre tabindex="0">'+('正在核对原文与译文段落，保留已经完成的内容。\\n'.repeat(35))+'</pre></details>';const e=document.querySelector('#input');e.value='翻译这个页面，只留下译文。\\n'.repeat(12);e.style.height='64px';e.style.maxHeight='64px';})()`);
 const state=await iso.evalIn(panel,`(()=>{const e=document.querySelector('details.thinking pre');e.scrollTop=100;return {color:getComputedStyle(e).scrollbarColor,width:getComputedStyle(e).scrollbarWidth,scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,inputColor:getComputedStyle(document.querySelector('#input')).scrollbarColor};})()`);
 assert.equal(state.width,'thin');assert.notEqual(state.color,'auto');assert.match(state.color,/rgba\(0, 0, 0, 0\)/);assert(state.scrollTop>0&&state.scrollHeight>state.clientHeight);
 await iso.screenshot(panel,resolve(out,'scrollbar-after.png'));
 await writeFile(resolve(out,'scrollbar-results.json'),JSON.stringify({passed:true,scope:'real built sidepanel with representative overflowing content; read+scroll behavior verified',state},null,2));
 console.log(JSON.stringify(state));
}finally{await iso.close();}
