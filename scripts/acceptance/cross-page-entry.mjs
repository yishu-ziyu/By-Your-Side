import { chromium } from '/Users/mahaoxuan/tools/gstack/node_modules/playwright/index.mjs';
import { mkdir,writeFile,readFile,readdir } from 'node:fs/promises';
const out='docs/evals/20260916-cross-page-entry';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:`${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`});
const page=await browser.newPage({viewport:{width:1100,height:650}});
const results=[];
try {
await page.setContent(`<meta charset="utf-8"><style>body{background:#f5f2eb;color:#292821;margin:100px auto;max-width:640px;font:18px/1.9 serif}h1{font-size:27px}p{margin-bottom:24px}</style><h1>让助手工作，让阅读继续</h1><p>当前文章保持可读。助手在其他页面核对资料时，右上角只保留一个轻量入口。</p><p>打开入口可以查看角色及工作页面，按需切换过去。本文是交互验收用的示例页面。</p>`);
const assets={};for(const name of await readdir('extension/assets/cast')){if(name.endsWith('.png'))assets['cast/'+name]='data:image/png;base64,'+(await readFile('extension/assets/cast/'+name)).toString('base64')}
await page.evaluate(assets=>{window.sent=[];window.chrome={runtime:{getURL:p=>assets[p],sendMessage:(msg,done)=>{window.sent.push(msg);done?.({ok:true})}}};const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){const s=attach.call(this,options);(window.roots??=[]).push(s);return s;}},assets);
await page.addScriptTag({path:'extension/dist/content-cursor.js'});
const kima='task-cast-kima-12345678';
const member={sessionId:kima,title:'YouTube · 视频字幕与来源核对',tabId:21,state:'reading'};
const check=async(name,fn)=>{const ok=await page.evaluate(fn);results.push({name,ok});if(!ok)throw Error(name);};
await page.evaluate(m=>{window.__sideagent.cursor.for(m.sessionId).setStatus({state:'waiting'});window.__sideagent.cursor.for(m.sessionId).showCrossPage(m)},member);
await check('same role waiting cursor hidden',()=>window.__sideagent.cursorStatus('task-cast-kima-12345678').hidden);
await check('identity and full title accessible',()=>{const b=window.roots[0].querySelector('.xpage button');return b.textContent.includes('Kima')&&b.title.includes('视频字幕')&&!!b.querySelector('svg')});
await page.screenshot({path:out+'/single.png'});
await page.evaluate(()=>window.__sideagent.clickCrossPage());
await check('single member target',()=>window.sent.at(-1).tabId===21);
await page.evaluate(m=>window.__sideagent.cursor.showCrossPage({...m,members:[m,{sessionId:'task-cast-omar-12345678',title:'文章 · 原始材料',tabId:22,state:'waiting'}]}),member);
await page.evaluate(()=>window.roots[0].querySelector('.xpage > button').focus());
await page.keyboard.press('Enter');
await check('keyboard expands members',()=>!window.roots[0].querySelector('.xlist').hidden);
await page.keyboard.press('Tab');await page.keyboard.press('Tab');await page.keyboard.press('Enter');
await check('second member target',()=>window.sent.at(-1).tabId===22);
await page.screenshot({path:out+'/multiple.png'});
await page.keyboard.press('Escape');
await check('escape restores trigger focus',()=>window.roots[0].querySelector('.xlist').hidden&&window.roots[0].activeElement===window.roots[0].querySelector('.xpage > button'));
await page.setViewportSize({width:320,height:650});
await check('narrow viewport contained',()=>{const r=window.__sideagent.crossPageState().rect;return r.x>=0&&r.x+r.width<=innerWidth});
await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
await page.screenshot({path:out+'/narrow-dark.png'});
await page.evaluate(()=>window.__sideagent.cursor.hideCrossPage());
await check('hidden entry removed from interaction',()=>window.__sideagent.crossPageState()===null);
await writeFile(out+'/result.json',JSON.stringify(results,null,2));console.log(results);
}finally{await browser.close()}
