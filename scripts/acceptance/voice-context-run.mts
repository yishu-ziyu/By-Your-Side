/** Step audio -> native route -> M3 vision/selection -> actual form values. */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {NativeVoiceHarness} from './native-voice-harness.mts';
const server=createServer((_q,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><title>语音资料验收</title><h1>资料录入</h1><p id="source">海风</p><label>图片数字<input id="digits" aria-label="图片数字"></label><label>选区口令<input id="password" aria-label="选区口令"></label>');});
let h:NativeVoiceHarness|undefined;const report:any={ok:false};
try{
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/`;
 h=await NativeVoiceHarness.open('voice-context');const id=await h.create('自动验收 · 页面图片');const tab=await h.openTab(id,url);
 const selected=await h.w(`chrome.scripting.executeScript({target:{tabId:${tab.tabId}},func:()=>{const el=document.querySelector('#source'),range=document.createRange();range.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(range);const text=s.toString();el.remove();return text;}}).then(r=>r[0].result)`);
 execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=white:s=600x240','-vf',"drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text=7391:fontcolor=black:fontsize=110:x=(w-tw)/2:y=(h-th)/2",'-frames:v','1',h.out+'/input.png']);
 const attachment={id:'image-fixture',type:'image' as const,name:'input.png',mimeType:'image/png' as const,dataBase64:(await readFile(h.out+'/input.png')).toString('base64')};
 await h.listen(id);await h.speak('请在这张页面的图片数字框填入所附图片里的四位数字，在选区口令框填入我选中的文字。填好后读取两个输入框确认。',{context:{tabId:tab.tabId,title:'语音资料验收',url,selection:{text:selected}},attachments:[attachment]});
 report.values=await h.wait(`chrome.scripting.executeScript({target:{tabId:${tab.tabId}},func:()=>({digits:document.querySelector('#digits').value,password:document.querySelector('#password').value,source:!!document.querySelector('#source')})}).then(r=>{const v=r[0].result;return v.digits==='7391'&&v.password==='海风'&&v;})`,120000);
 h.check('image-only digits and removed selected text reached real form',report.values.digits==='7391'&&report.values.password==='海风'&&!report.values.source);
 await h.wait(`${h.events(id)}.some(e=>e.type==='agent_event'&&e.event.kind==='agent_end')`,90000);
 await h.wait(`${h.events(id)}.some(e=>e.type==='voice'&&e.event.kind==='text'&&e.event.role==='assistant'&&e.event.text==='这一轮执行已经结束，结果还没有确认。')`,30000);
 h.check('unsolicited end report did not claim verified success',true);report.ok=true;
}catch(e){report.error=String(e);process.exitCode=1;}
finally{if(h){report.events=await h.w(`(globalThis.__saServerEvents||[]).filter(e=>${JSON.stringify(h.ids)}.includes(e.conversationId)&&e.type!=='tool_call'&&!(e.type==='voice'&&e.event.kind==='audio'))`).catch(()=>[]);await h.finishReport(report);await h.close();console.log(JSON.stringify({out:h.out,ok:report.ok,error:report.error}));}server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
