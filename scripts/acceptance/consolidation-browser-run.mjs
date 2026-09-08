import {mkdir,writeFile} from 'node:fs/promises';
import {connectParentAcceptance} from './parent-tab-control-run.mjs';
import {evaluateInWorker} from './cdp.mjs';
import {sideagentExtensionId} from './constants.mjs';
const output='/tmp/sideagent-consolidation-browser';await mkdir(output,{recursive:true});
const c=await connectParentAcceptance(),{cdp,sid,url}=c;
const checks=[],opened=[];let target,ui;
const check=(name,ok)=>{checks.push({name,ok});if(!ok)throw Error(name);console.log('PASS '+name);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function ev(expression){const r=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},ui);if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result?.value;}
const a='merge-teach-'+Date.now(),b='merge-act-'+Date.now();
try {
  for(const [cid,mode] of [[a,'teach'],[b,'act']]){
    const r=await c.tool(cid,'main','open_tab',{url});if(!r.ok)throw Error(r.error);opened.push(r.data.tabId);
    await evaluateInWorker(cdp,sid,`chrome.scripting.executeScript({target:{tabId:${r.data.tabId}},func:(cid,mode)=>{const p=chrome.runtime.connect({name:'sideagent-panel'});p.postMessage({kind:'client',msg:{type:'set_mode',mode,conversationId:cid}});setTimeout(()=>p.disconnect(),200);},args:${JSON.stringify([cid,mode])}})`);
    await sleep(300);
    const marked=await c.tool(cid,'main','mark',{target:'#result',label:'会话样式检查'});if(!marked.ok)throw Error(marked.error);
    const style=await evaluateInWorker(cdp,sid,`chrome.scripting.executeScript({target:{tabId:${r.data.tabId}},func:()=>{let sketch=0,marks=0;for(const el of document.querySelectorAll('*')){const root=chrome.dom.openOrClosedShadowRoot(el);if(root){sketch+=root.querySelectorAll('.mark.sketch').length;marks+=root.querySelectorAll('.mark').length;}}return {sketch,marks};}}).then(r=>r[0].result)`);
    check(mode==='teach'?'教学会话实际绘出手绘标注':'操作会话保持矩形标注',mode==='teach'?style.sketch>0:style.marks>0&&style.sketch===0);
  }
  target=(await cdp.send('Target.createTarget',{url:'about:blank',background:true})).targetId;ui=await cdp.attachSession(target);
  await cdp.send('Page.enable',{},ui);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{let listeners=[];window.__sends=[];window.__fault=false;window.__emit=m=>listeners.forEach(f=>f(m));chrome.runtime.connect=()=>({postMessage:m=>{if(window.__fault&&m.kind==='client')throw Error('injected disconnect');window.__sends.push(m);},onMessage:{addListener:f=>listeners.push(f)},onDisconnect:{addListener:()=>{}}});})()`},ui);
  await cdp.send('Page.navigate',{url:'chrome-extension://'+sideagentExtensionId()+'/sidepanel.html?merge-check='+Date.now()},ui);
  for(let i=0;i<50;i++){if(await ev(`!!document.querySelector('#input')&&!!window.__emit`))break;await sleep(100);}
  await ev(`__emit({kind:'conn',state:'connected'});__emit({kind:'conversations',selectedConversationId:'merge-ui-A',conversations:['merge-ui-A','merge-ui-B'].map(id=>({id,title:id,createdAt:1,updatedAt:1,state:'idle',mode:'act'}))});`);
  await sleep(100);
  await ev(`__emit({kind:'ask_selection',conversationId:'merge-ui-A',ask:{tabId:1,title:'测试',url:'https://example.test',text:'保留引用'}});__fault=true;document.querySelector('#input').focus();`);
  await cdp.send('Input.insertText',{text:'保留正文'},ui);
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},ui);await sleep(100);
  check('发送失败保留正文和引用',await ev(`document.querySelector('#input').value==='保留正文'&&!document.querySelector('#ask-cite').hidden&&document.body.innerText.includes('没有发出去')`));
  await ev(`__fault=false;__emit({kind:'history',conversationId:'merge-ui-A',entries:[{seq:5,item:{kind:'user',text:'未送达原文'}}]});__emit({kind:'delivery',conversationId:'merge-ui-B',seq:5,ok:false,original:{type:'user_message',conversationId:'merge-ui-B',text:'另一会话'}});`);
  check('其他会话同号回执不污染当前气泡',await ev(`document.querySelectorAll('.undelivered').length===0`));
  await ev(`__emit({kind:'delivery',conversationId:'merge-ui-A',seq:5,ok:false,original:{type:'user_message',conversationId:'merge-ui-A',text:'未送达原文'}});`);
  check('原会话显示未送达和重试',await ev(`document.querySelectorAll('.undelivered').length===1&&!!document.querySelector('[data-retry]')`));
  const rect=await ev(`(()=>{const r=document.querySelector('[data-retry]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...rect},ui);await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...rect},ui);
  check('重试发送原文到原会话且不清空新输入',await ev(`__sends.some(m=>m.kind==='client'&&m.msg.conversationId==='merge-ui-A'&&m.msg.text==='未送达原文')&&document.querySelector('#input').value==='保留正文'`));
  await ev(`__emit({kind:'conversations',selectedConversationId:'merge-ui-B',conversations:[]});__emit({kind:'history',conversationId:'merge-ui-B',entries:[{seq:5,item:{kind:'user',text:'B内容'}}]});`);
  check('切换会话清除旧气泡索引',await ev(`document.querySelectorAll('.undelivered').length===0&&document.querySelectorAll('.msg.user').length===1`));
  await ev(`__emit({kind:'conversations',selectedConversationId:'merge-ui-A',conversations:[]});__emit({kind:'history',conversationId:'merge-ui-A',entries:[{seq:5,item:{kind:'user',text:'未送达原文',undelivered:{original:{type:'user_message',conversationId:'merge-ui-A',text:'未送达原文'}}}}]});`);
  check('重开历史恢复失败标记且不重复气泡',await ev(`document.querySelectorAll('.undelivered').length===1&&document.querySelectorAll('.msg.user').length===1`));
  const shot=await cdp.send('Page.captureScreenshot',{format:'png'},ui);await writeFile(output+'/delivery.png',Buffer.from(shot.data,'base64'));
  await writeFile(output+'/result.json',JSON.stringify({ok:true,checks,scope:'Real Chrome production mark; production sidepanel UI with injected Port failures. Backend receipts checked separately against production controller.'},null,2));
}catch(error){console.error(error);process.exitCode=1;await writeFile(output+'/result.json',JSON.stringify({ok:false,error:String(error),checks},null,2));}
finally{if(target)await cdp.send('Target.closeTarget',{targetId:target}).catch(()=>{});for(const id of opened)await evaluateInWorker(cdp,sid,`chrome.tabs.remove(${id}).catch(()=>{})`);await c.close();}
