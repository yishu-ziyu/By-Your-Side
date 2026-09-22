/** Actual stylesheet and Chromium geometry; no source-string assertions. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {launchIsolatedExtension,until} from './isolated-extension.mts';

if(!process.argv.includes('--headless'))throw Error('Required --headless');

const css=await readFile('extension/src/sidepanel/styles.css','utf8');

const rows=Array.from({length:30},(_,i)=>`<details class="run-steps"><summary>查看执行过程 ${i+1}</summary><div class="run-body"><p>结果内容</p></div></details>`).join('');

const browser=await launchIsolatedExtension({fixtureHtml:`<!doctype html><style>${css}</style><div id="messages" style="height:400px;width:360px">${rows}</div>`});

try{
 const page=await browser.newTarget(browser.fixtureOrigin+'/layout');
 await until(async()=>await browser.evalIn(page,"document.querySelectorAll('details').length===30")||undefined,5000,'rows');
 const rows=await browser.evalIn(page,`[...document.querySelectorAll('details')].map(e=>{const r=e.getBoundingClientRect(),s=e.querySelector('summary');return {top:r.top,bottom:r.bottom,height:s.getBoundingClientRect().height,shrink:getComputedStyle(e).flexShrink,box:getComputedStyle(s).boxSizing}})`) as any[];
 assert(rows.every(r=>r.height>=32&&r.shrink==='0'&&r.box==='border-box'));
 assert(rows.every((r,i)=>i===0||r.top>=rows[i-1].bottom));
 await mkdir('docs/evals/20260916-release',{recursive:true});await writeFile('docs/evals/20260916-release/steps-layout.json',JSON.stringify({ok:true,rows},null,2));console.log('30 actual rows retain size without overlap');
}finally{await browser.close();}
