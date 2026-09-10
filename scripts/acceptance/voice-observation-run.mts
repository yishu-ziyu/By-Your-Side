/** Real active-page observation while a different tab remains the task working tab. */
import {createServer} from 'node:http';
import {NativeVoiceHarness} from './native-voice-harness.mts';
const server=createServer((q,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(`<!doctype html><meta charset="utf-8"><title>${q.url==='/task'?'工作页':'当前可见页'}</title><h1 style="font-size:80px">${q.url==='/task'?'红色山丘':'蓝色小船'}</h1><canvas width="500" height="140"></canvas><script>const c=document.querySelector('canvas').getContext('2d');c.fillStyle='${q.url==='/task'?'red':'blue'}';for(let i=0;i<${q.url==='/task'?5:3};i++){c.beginPath();c.arc(50+i*90,70,30,0,Math.PI*2);c.fill();}</script><p style="margin-top:3000px">底部不可见代号：月亮饼干</p>`);});
let h:NativeVoiceHarness|undefined;const report:any={ok:false};
try{
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const root=`http://127.0.0.1:${(server.address() as any).port}`;
 h=await NativeVoiceHarness.open('voice-observation');const id=await h.create('自动验收 · 当前可见页面'),task=await h.openTab(id,root+'/task');
 const active=await h.w(`chrome.tabs.create({url:${JSON.stringify(root+'/visible')},active:true})`);h.tabs.add(active.id);await new Promise(r=>setTimeout(r,500));
 const before=await h.w(`chrome.storage.session.get(null)`);const speaking=h.listen(id).then(()=>h!.speak('请看当前浏览器页面，告诉我可见的大字，以及画布里有几个圆形。'));
 const call=await h.wait(`${h.events(id)}.find(e=>e.type==='tool_call'&&e.name==='observe_page')`,60000);
 await speaking;
 const answers=await h.w(`${h.events(id)}.filter(e=>e.type==='voice'&&e.event.kind==='text'&&e.event.role==='assistant').map(e=>e.event.text)`);report.answers=answers;
 h.check('pixel-only circle count is read from the current page image',answers.some((s:string)=>{const plain=s.replace(/[*\s]/g,'');const count=plain.match(/([0-9]+|[一二三四五六七八九十]+)个[^。]*圆/)?.[1]??plain.match(/圆[^0-9一二三四五六七八九十]*([0-9]+|[一二三四五六七八九十]+)个/)?.[1];return count==='3'||count==='三';}));
 h.check('spoken answer names the current visible page',answers.some((s:string)=>s.includes('蓝色小船'))&&!answers.some((s:string)=>s.includes('红色山丘')||s.includes('月亮饼干')));
 const captured=await h.connection.tool(id,'main','observe_page',call.params);if(!captured.ok)throw Error(captured.error);report.capture={...captured.data,imageBase64:'[omitted]'};
 h.check('DOM and image have an actual document and viewport source',captured.data.tabId===active.id&&captured.data.scope==='viewport'&&!!captured.data.documentId&&!!captured.data.imageBase64&&!captured.data.text.includes('月亮饼干'));
 h.check('working tab binding evidence is present',!!before.workingTabs&&JSON.stringify(before.workingTabs).includes(String(task.tabId)));
 const after=await h.w(`chrome.storage.session.get(null)`);const working=(state:any)=>Object.fromEntries(Object.entries(state).filter(([key])=>/workingTab|workingTabs|tabClaims|tabResources/.test(key)));
 h.check('observation did not change working tab bindings',JSON.stringify(working(before))===JSON.stringify(working(after)));
 h.check('observation did not activate the task working tab',await h.w(`chrome.tabs.query({active:true,lastFocusedWindow:true}).then(t=>t[0]?.id===${active.id})`));
 await h.w(`(()=>{globalThis.__voiceOriginalCapture=chrome.tabs.captureVisibleTab.bind(chrome.tabs);chrome.tabs.captureVisibleTab=async(...args)=>{const image=await __voiceOriginalCapture(...args);await chrome.tabs.reload(${active.id});for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,100));const [doc]=await chrome.scripting.executeScript({target:{tabId:${active.id}},func:()=>location.href}).catch(()=>[]);if(doc?.documentId&&doc.documentId!==${JSON.stringify(captured.data.documentId)})break;}return image;};})()`);
 const navigated=await h.connection.tool(id,'main','observe_page',call.params);
 await h.w(`chrome.tabs.captureVisibleTab=__voiceOriginalCapture;delete globalThis.__voiceOriginalCapture`);
 h.check('same-URL reload during capture rejects mixed evidence',!navigated.ok&&String(navigated.error).includes('变化'));
 await h.w(`chrome.tabs.update(${task.tabId},{active:true})`);const switched=await h.connection.tool(id,'main','observe_page',call.params);h.check('stale active-page grant is rejected after a tab switch',!switched.ok);
 h.check('observation did not start a task',await h.w(`${h.events(id)}.filter(e=>e.type==='agent_event'&&e.event.kind==='agent_start').length===0`));report.ok=true;
}catch(e){report.error=String(e);process.exitCode=1;}
finally{if(h){await h.w(`if(globalThis.__voiceOriginalCapture){chrome.tabs.captureVisibleTab=__voiceOriginalCapture;delete globalThis.__voiceOriginalCapture}`).catch(()=>{});await h.finishReport(report);await h.close();console.log(JSON.stringify({out:h.out,ok:report.ok,error:report.error}));}server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
