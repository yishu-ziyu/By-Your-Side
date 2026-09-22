import { chromium } from '/Users/mahaoxuan/tools/gstack/node_modules/playwright/index.mjs';
import { mkdir,writeFile,readFile,readdir } from 'node:fs/promises';

const out='docs/evals/20260916-unified-cursor';

await mkdir(out,{recursive:true});

const browser=await chromium.launch({headless:true,executablePath:`${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`});

const page=await browser.newPage({viewport:{width:1100,height:650}});

const results=[];

try {
await page.setContent(`<meta charset="utf-8"><style>body{background:#f5f2eb;color:#292821;margin:100px auto;max-width:640px;font:18px/1.9 serif}h1{font-size:27px}p{margin-bottom:24px}</style><h1>让助手工作，让阅读继续</h1><p>当前文章保持可读。助手在其他页面核对资料时，右上角只保留一个轻量入口。</p><p>打开入口可以查看角色及工作页面，按需切换过去。本文是交互验收用的示例页面。</p>`);
const assets={};

for(const name of await readdir('extension/assets/cast')){if(name.endsWith('.png'))assets['cast/'+name]='data:image/png;base64,'+(await readFile('extension/assets/cast/'+name)).toString('base64')}

await page.evaluate(assets=>{window.sent=[];window.chrome={runtime:{getURL:p=>assets[p],sendMessage:(msg,done)=>{window.sent.push(msg);done?.({ok:true})}}};const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){const s=attach.call(this,options);(window.roots??=[]).push(s);

return s;}},assets);
await page.addScriptTag({path:'extension/dist/content-cursor.js'});
const kima='task-cast-kima-12345678';
const member={sessionId:kima,title:'YouTube · 视频字幕与来源核对',tabId:21,state:'reading'};

const check=async(name,fn)=>{const ok=await page.evaluate(fn);results.push({name,ok});

if(!ok)throw Error(name);};

await page.evaluate(m=>{window.__sideagent.cursor.for(m.sessionId).setStatus({state:'waiting'});window.__sideagent.cursor.for(m.sessionId).showCrossPage(m)},member);
await check('same role waiting cursor hidden',()=>window.__sideagent.cursorStatus('task-cast-kima-12345678').hidden);
await check('identity and full title accessible',()=>{const b=window.roots[0].querySelector('.xpage button');

return b.textContent.includes('Kima')&&b.title.includes('视频字幕')&&!!b.querySelector('svg')});
await page.screenshot({path:out+'/single.png'});
await page.evaluate(()=>window.__sideagent.clickCrossPage());
await check('single member target',()=>window.sent.at(-1).tabId===21);
await page.evaluate(m=>window.__sideagent.cursor.showCrossPage({...m,members:[m,{sessionId:'task-cast-omar-12345678',title:'文章 · 原始材料',tabId:22,state:'waiting'}]}),member);
await page.evaluate(()=>window.roots[0].querySelector('.xpage > button').focus());
await page.keyboard.press('Enter');
await check('keyboard expands members',()=>!window.roots[0].querySelector('.xlist').hidden);

if(process.argv.includes('--motion')) {
  await check('list opens from top right with transition',()=>{const l=window.roots[0].querySelector('.xlist');

return getComputedStyle(l).transitionDuration.includes('0.25s')&&!l.inert});
  await page.evaluate(()=>{const b=window.roots[0].querySelector('.xpage > button');b.click();b.click();b.click()});
  await check('rapid close is immediately inert',()=>{const l=window.roots[0].querySelector('.xlist');

return l.hidden&&l.inert});
  await page.evaluate(()=>window.roots[0].querySelector('.xpage > button').click());
}

await page.keyboard.press('Tab');await page.keyboard.press('Tab');await page.keyboard.press('Enter');
await check('second member target',()=>window.sent.at(-1).tabId===22);
await page.screenshot({path:out+'/multiple.png'});
await page.keyboard.press('Escape');
await check('escape restores trigger focus',()=>window.roots[0].querySelector('.xlist').hidden&&window.roots[0].activeElement===window.roots[0].querySelector('.xpage > button'));
await page.setViewportSize({width:320,height:650});
await check('narrow viewport contained',()=>{const r=window.__sideagent.crossPageState().rect;

return r.x>=0&&r.x+r.width<=innerWidth});
await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
await page.screenshot({path:out+'/narrow-dark.png'});
await page.evaluate(()=>window.__sideagent.cursor.hideCrossPage());
await check('hidden entry removed from interaction',()=>window.__sideagent.crossPageState()===null);

await page.setViewportSize({width:1100,height:650});
await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});
await page.evaluate(()=>window.__sideagent.cursor.setStatus({state:'reading'}));
await check('local reading uses shared upper right entry',()=>window.roots[0].querySelector('.xpage').textContent.includes('正在读这个页面'));
await check('local status label stays hidden',()=>getComputedStyle(window.roots[0].querySelector('.cursor .label')).display==='none');
await page.screenshot({path:out+'/reading.png'});
await page.evaluate(()=>window.__sideagent.cursor.setStatus({state:'waiting'}));

if(process.argv.includes('--motion')) {
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>{const c=window.__sideagent.cursor;c.setStatus({state:'reading'});c.setStatus({state:'waiting'});c.setStatus({state:'failed'})});
  await check('latest state wins without animation queue',()=>window.roots[0].querySelector('.xpage').textContent.includes('这一步没做成'));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>window.__sideagent.cursor.setStatus({state:'waiting'}));
  await check('reduced motion disables text animation',()=>window.roots[0].querySelector('.xsub').getAnimations().length===0);
}

await check('waiting makes no model or duration claim',()=>window.roots[0].querySelector('.xpage').textContent.includes('处理中')&&!window.roots[0].querySelector('.xpage').textContent.includes('模型'));
await page.evaluate(m=>window.__sideagent.cursor.for(m.sessionId).showCrossPage(m),member);
await check('local and remote roles coexist',()=>window.roots[0].querySelector('.xmain').textContent==='2 位助手');
await page.evaluate(()=>window.__sideagent.cursor.hideCrossPage());
await check('remote clear preserves local state',()=>window.roots[0].querySelector('.xpage').textContent.includes('处理中'));
await page.evaluate(()=>{const el=document.querySelector('h1'),r=el.getBoundingClientRect();window.__sideagent.cursor.beginAction('one','click',{x:r.x,y:r.y,width:r.width,height:r.height},el,'文章标题')});
await check('action text lives in status entry not cursor',()=>window.roots[0].querySelector('.xpage').textContent.includes('正在点击')&&getComputedStyle(window.roots[0].querySelector('.cursor .label')).display==='none');
await page.evaluate(()=>window.__sideagent.cursor.endAction('one','unknown'));
await page.waitForTimeout(1800);
await check('unknown outcome remains visible',()=>window.roots[0].querySelector('.xpage').textContent.includes('结果待确认'));
await page.evaluate(()=>window.__sideagent.cursor.hold(450,140,[{id:'confirm',label:'确认'},{id:'cancel',label:'取消'}],'h1'));
await page.waitForTimeout(300);
await check('only approval shows local buttons',()=>{const c=window.roots[0].querySelector('.cursor.holding');

return !!c&&getComputedStyle(c.querySelector('.label')).display==='flex'&&c.querySelectorAll('button').length===2});
await page.screenshot({path:out+'/confirmation.png'});
await page.evaluate(()=>window.roots[0].querySelector('.hold-action.confirm').focus());
await page.keyboard.press('Enter');
await check('keyboard approval sends real handler message',()=>window.sent.at(-1).type==='mark_action'&&window.sent.at(-1).action==='confirm');
await page.evaluate(()=>{window.__sideagent.cursor.releaseHold();window.__sideagent.cursor.hide();window.__sideagent.cursor.setStatus({state:'done'})});
await page.waitForTimeout(1700);
await check('end hint expires',()=>window.__sideagent.crossPageState()===null);
await page.evaluate(()=>window.__sideagent.cursor.setStatus({state:'failed'}));
await page.screenshot({path:out+'/failed.png'});
await check('failure stays in status entry',()=>window.roots[0].querySelector('.xpage').textContent.includes('这一步没做成'));
await page.evaluate(()=>window.__sideagent.cursor.hide());
await check('stop cleanup removes state',()=>window.__sideagent.crossPageState()===null);
await writeFile(out+'/result.json',JSON.stringify(results,null,2));console.log(results);
}finally{await browser.close()}
