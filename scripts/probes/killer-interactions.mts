/** Prerequisite only: ISOLATED-world helper persistence and real drag data crossing renderer targets. */
import { createServer } from 'node:http';
import { launchRealPath, requireHeadless, siteAddress, until, sleep } from '../acceptance/real-path/harness.mts';

requireHeadless();

const site=createServer((_q,r)=>r.end('<!doctype html><table draggable="true" style="margin:80px;width:300px;height:120px"><tr><td>62.4%</td></tr></table><script>document.querySelector("table").ondragstart=e=>e.dataTransfer.setData("text/plain","probe-feed-token");</script>'));

await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));

const origin=`http://127.0.0.1:${siteAddress(site).port}`;

const rp=await launchRealPath();

try {
  const work=await rp.attach((await rp.targets()).find(t=>t.url==='about:blank')!.targetId);
  await rp.cdp.send('Page.navigate',{url:origin},work);
  await until(async()=>await rp.evaluate(work,'!!document.querySelector("table")'),5000,'table');
  const panel=await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel,`chrome.tabs.query({}).then(async ts=>{const id=ts.find(t=>t.url.startsWith(${JSON.stringify(origin)})).id;await chrome.scripting.executeScript({target:{tabId:id},world:'ISOLATED',func:()=>{globalThis.__peelProbe=()=>"retained"}});const [r]=await chrome.scripting.executeScript({target:{tabId:id},world:'ISOLATED',func:()=>globalThis.__peelProbe()});if(r.result!=="retained")throw Error('lost helper')})`);
  const captured=rp.cdp.waitForEvent('Input.dragIntercepted',8000);
  await rp.cdp.send('Input.setInterceptDrags',{enabled:true},work);
  await rp.cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:120,y:120,button:'left',clickCount:1},work);
  await rp.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:200,y:160,button:'left',buttons:1},work);
  const event=await captured;
  const data=event.params.data;
  await rp.evaluate(panel,'globalThis.__dropProbe=null;document.body.addEventListener("drop",e=>{e.preventDefault();globalThis.__dropProbe=e.dataTransfer.getData("text/plain")});document.body.addEventListener("dragover",e=>e.preventDefault())');

  for(const type of ['dragEnter','dragOver','drop'])await rp.cdp.send('Input.dispatchDragEvent',{type,x:100,y:100,data},panel);
  await sleep(100);
  const result=await rp.evaluate(panel,'globalThis.__dropProbe');

  if(result!=='probe-feed-token')throw Error(`drag payload lost: ${result}`);
  const state=await rp.evaluate(work,'({hit:document.elementFromPoint(120,120)?.outerHTML.slice(0,150),draggable:document.querySelector("table").draggable,selection:getSelection().toString()})');
  await rp.cdp.send('Input.dispatchDragEvent',{type:'dragCancel',x:200,y:160,data},work);
  const second=rp.cdp.waitForEvent('Input.dragIntercepted',3000);
  await rp.cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:200,y:160,button:'left',clickCount:1},work);
  await rp.cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:120,y:120,button:'left',clickCount:1},work);
  await rp.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:200,y:160,button:'left',buttons:1},work);
  let repeat=false;


  try{repeat=!!(await second).params.data;}catch{}


  console.log(JSON.stringify({isolatedHelper:true,crossRendererDrop:result,repeat,state}));
} finally {await rp.close();await rp.remove();await new Promise<void>(r=>site.close(()=>r()));}
