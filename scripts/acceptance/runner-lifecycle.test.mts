/** Offline counterexamples; node --import tsx --test scripts/acceptance/runner-lifecycle.test.mts */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCdp} from './cdp.mjs';

class Socket extends EventTarget {
  static OPEN=1; static CLOSING=2; static CLOSED=3;
  readyState=Socket.OPEN;
  listeners=new Map<string,Set<any>>();
  addEventListener(type:string,fn:any,options?:any){super.addEventListener(type,fn,options);if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type)!.add(fn);}
  removeEventListener(type:string,fn:any){super.removeEventListener(type,fn);this.listeners.get(type)?.delete(fn);}
  send(_frame:string){}
  close(){this.readyState=Socket.CLOSED;this.dispatchEvent(new Event('close'));}
  message(frame:any){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(frame)}));}
}
const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
for(const disconnect of [false,true])test(`CDP ${disconnect?'disconnect':'close'} settles requests and waits`,async t=>{
  const timers=new Set<any>();
  const originalWebSocket=globalThis.WebSocket;
  globalThis.WebSocket=Socket as any;t.after(()=>{globalThis.WebSocket=originalWebSocket;});
  t.mock.method(globalThis,'setTimeout',(fn:any)=>{const timer={fn};timers.add(timer);return timer;});
  t.mock.method(globalThis,'clearTimeout',(timer:any)=>timers.delete(timer));
  const cdp=createCdp('ws://offline');await cdp.ready();
  const settled:string[]=[];
  cdp.send('Runtime.evaluate').then(()=>settled.push('request resolved'),()=>settled.push('request rejected'));
  cdp.waitForEvent('Debugger.paused').then(()=>settled.push('event resolved'),()=>settled.push('event rejected'));
  cdp.onEvent('Runtime.consoleAPICalled',()=>{});
  if(disconnect)cdp.ws.close();else await cdp.close();
  await flush();
  assert.deepEqual(settled.sort(),['event rejected','request rejected']);
  assert.equal(timers.size,0,'CDP timers survived close');
  assert.equal([...cdp.ws.listeners.values()].reduce((sum,s)=>sum+s.size,0),0,'socket listeners survived close');
  await cdp.close();
  await assert.rejects(cdp.send('Runtime.evaluate'),/closed|断开/);
  await assert.rejects(cdp.waitForEvent('Debugger.paused'),/closed|断开/);
  await assert.rejects(cdp.ready(),/closed|断开/);
  assert.equal(timers.size,0);
});

import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {createServer} from 'node:http';
import {installExecuteToolCallHook,prepareProbeExpression} from './sw-hook.mjs';
import {createDeliveryQueue,superviseWorker,workerExitCode} from './unknown-fill-chrome.mts';
import {closeIsolatedResources} from './isolated-extension.mts';

function useSocket(t:any,Constructor:any){const original=globalThis.WebSocket;globalThis.WebSocket=Constructor;t.after(()=>{globalThis.WebSocket=original;});}

test('CDP session filtering, abort, send failure and successful replies release waits',async t=>{
  useSocket(t,Socket);const cdp=createCdp('ws://offline');
  const abort=new AbortController();
  const paused=cdp.waitForEvent('Debugger.paused',1000,{sessionId:'worker',signal:abort.signal});
  cdp.ws.message({method:'Debugger.paused',sessionId:'other'});
  assert.equal(cdp.diagnostics().operations.length,1);
  abort.abort();await assert.rejects(paused);
  const request=cdp.send('Runtime.evaluate');cdp.ws.message({id:1,result:{ok:true}});
  assert.deepEqual(await request,{ok:true});
  cdp.ws.send=()=>{throw Error('send failed');};
  await assert.rejects(cdp.send('Runtime.evaluate'),/send failed/);
  assert.equal(cdp.diagnostics().requests,0);assert.equal(cdp.diagnostics().operations.length,0);
  await cdp.close();
});

test('CDP ready is rejected on close and errors; repeated close is safe',async t=>{
  class Connecting extends Socket {readyState=0;}
  useSocket(t,Connecting);const cdp=createCdp('ws://offline');
  const ready=cdp.ready();cdp.ws.dispatchEvent(new Event('error'));
  await assert.rejects(ready,/closed/);await Promise.all([cdp.close(),cdp.close()]);
  assert.deepEqual(cdp.diagnostics(),{closed:true,requests:0,operations:[],listeners:[]});
});

test('probe waits for actual complete and confirms injection; no fixed sleep',async()=>{
  const url='http://127.0.0.1/hook';let updated:any,removed=0,injected=0;
  const context={chrome:{tabs:{
    create:async()=>({id:3}),get:async()=>({id:3,status:'loading',url}),
    onUpdated:{addListener(fn:any){updated=fn;},removeListener(){removed++;}},
  },scripting:{executeScript:async()=>{injected++;return [{documentId:'probe-doc',result:{ready:'complete',url}}];}}},setTimeout,clearTimeout};
  const ready=vm.runInNewContext(prepareProbeExpression(url),context);
  await flush();assert.equal(injected,0);
  updated(99,{status:'complete'},{id:99,status:'complete',url});await flush();assert.equal(injected,0);
  updated(3,{status:'complete'},{id:3,status:'complete',url});
  assert.equal((await ready).documentId,'probe-doc');assert.equal(injected,1);assert.equal(removed,1);
  context.chrome.scripting.executeScript=async()=>{throw Error('injection denied');};
  context.chrome.tabs.get=async()=>({id:3,status:'complete',url});
  await assert.rejects(vm.runInNewContext(prepareProbeExpression(url),context),/injection denied/);
});

for(const mode of ['normal','trigger-failure','disconnect'] as const)test(`hook ${mode}: one trigger, session-scoped pause, cleanup`,{timeout:2000},async t=>{
  let hooked=false,trigger:any,triggers=0,resumed=false;
  const calls:string[]=[],diagnostics:any[]=[];
  class HookSocket extends Socket {
    send(raw:string){
      const m=JSON.parse(raw);calls.push(m.method);
      const reply=(value:any={})=>queueMicrotask(()=>this.message({id:m.id,result:value}));
      if(m.method==='Runtime.evaluate'){
        const expression=m.params.expression;
        if(expression==='typeof globalThis.__saCall'){reply({result:{value:hooked?'function':'undefined'}});return;}
        if(expression.includes('const tab = await chrome.tabs.create')){reply({result:{value:{tabId:3,documentId:'probe-doc'}}});return;}
        if(expression.includes('const message = chrome.runtime.sendMessage')){
          triggers++;trigger=m;
          if(mode==='trigger-failure'){reply({exceptionDetails:{text:'injection failed'}});return;}
          if(mode==='disconnect'){queueMicrotask(()=>this.close());return;}
          queueMicrotask(()=>{
            this.message({method:'Debugger.paused',sessionId:'unrelated',params:{hitBreakpoints:['bp'],callFrames:[{callFrameId:'wrong'}]}});
            this.message({method:'Debugger.paused',sessionId:'worker',params:{hitBreakpoints:['bp'],callFrames:[{callFrameId:'right'}]}});
          });return; // Trigger result deliberately held until SW resumes.
        }
        reply({result:{value:[{result:{sent:true}}]}});return;
      }
      if(m.method==='Debugger.enable'){
        reply();setTimeout(()=>this.message({method:'Debugger.scriptParsed',sessionId:'worker',params:{scriptId:'script',url:'chrome-extension://test/background.js'}}),200);return;
      }
      if(m.method==='Debugger.getScriptSource'){reply({scriptSource:'chrome.runtime.onMessage.addListener(() => {\nhandler();\n});'});return;}
      if(m.method==='Debugger.setBreakpoint'){reply({breakpointId:'bp'});return;}
      if(m.method==='Debugger.evaluateOnCallFrame'){
        assert.equal(m.params.callFrameId,'right');hooked=true;reply({result:{value:{ok:true}}});return;
      }
      if(m.method==='Debugger.resume'){
        resumed=true;reply();queueMicrotask(()=>this.message({id:trigger.id,result:{result:{value:[{result:{sent:true}}]}}}));return;
      }
      reply();
    }
  }
  useSocket(t,HookSocket);const cdp=createCdp('ws://offline');
  const work=installExecuteToolCallHook(cdp,'worker','test','http://127.0.0.1/hook',(kind:string,data:any)=>diagnostics.push({kind,data}));
  if(mode==='normal'){
    assert.equal((await work).ok,true);assert(resumed);
    assert.equal(diagnostics.filter(d=>d.kind==='debugger-paused').length,2);
    assert(calls.indexOf('Debugger.removeBreakpoint')<calls.indexOf('Debugger.resume'));
  }else await assert.rejects(work,mode==='trigger-failure'?/injection failed/:/closed/);
  assert.equal(triggers,1);assert.equal(cdp.diagnostics().operations.length,0);
  assert.deepEqual(cdp.diagnostics().listeners,[]);await cdp.close();
});

test('delivery stops admission, drains in order, and terminates queued work before resource close',async()=>{
  let release!:()=>void;const seen:number[]=[],events:any[]=[];
  const queue=createDeliveryQueue(async m=>{seen.push(m.id);if(m.id===1)await new Promise<void>(r=>{release=r;});},(kind,data)=>events.push({kind,data}));
  queue.push({id:1});queue.push({id:2});await flush();
  queue.stop();assert.equal(queue.push({id:3}),false);assert.equal(queue.snapshot().pending.length,2);
  release();await queue.drain();assert.deepEqual(seen,[1,2]);assert.equal(queue.snapshot().pending.length,0);
  let reject!:(error:Error)=>void;
  const stuck=createDeliveryQueue(async m=>{seen.push(m.id);await new Promise<void>((_,r)=>{reject=r;});},()=>{});
  stuck.push({id:4});stuck.push({id:5});await flush();
  await assert.rejects(stuck.drain(10),/timed out/);stuck.terminate();reject(Error('CDP closed'));
  await assert.rejects(stuck.drain(),/CDP closed/);
  assert.equal(stuck.snapshot().pending.length,0);assert(!seen.includes(5));
});

test('partial isolation cleanup reports actual resources and continues after CDP failure',async()=>{
  const fixture=createServer();await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));
  const result=await closeIsolatedResources({fixture,cdp:{close:async()=>{throw Error('close timeout');}} as any});
  assert.equal(result.status,'FAIL');assert.deepEqual(result.resources,{cdp:'FAILED',chrome:'NOT_CREATED',fixture:'CLOSED'});
  const empty=await closeIsolatedResources({});assert.deepEqual(empty.resources,{cdp:'NOT_CREATED',chrome:'NOT_CREATED',fixture:'NOT_CREATED'});
});

for(const [status,cleanup,code,hang] of [
  ['PASS','PASS',0,false],['BLOCKED','PASS',0,false],['FAIL','PASS',0,false],
  ['PASS','FAIL',0,false],['PASS','PASS',2,false],['PASS','PASS',0,true],
] as const)test(`supervisor ${status}/${cleanup}, worker=${code}, hang=${hang}`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'bys-offline-supervisor-'));
  const result={status,cleanup:{status:cleanup}};
  const script="require('node:fs').writeFileSync(process.argv[1],process.argv[2]);process.exitCode=Number(process.argv[3]);if(process.argv[4]==='true')setInterval(()=>{},1000)";
  const report=await superviseWorker({command:process.execPath,args:['-e',script,join(dir,'result.json'),JSON.stringify(result),String(code),String(hang)],dir,timeoutMs:300});
  const expected=status==='PASS'&&cleanup==='PASS'&&code===0&&!hang?0:1;
  assert.equal(report.process.overallExitCode,expected);assert.equal(report.process.timedOut,hang);
  assert.equal(workerExitCode(result),status==='PASS'&&cleanup==='PASS'?0:1);
  if(!hang)assert.equal(report.process.groupTerminationSent,false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'supervisor.json'),'utf8')),report.process);
});

test('supervisor spawn failure and missing result fail closed',async()=>{
  for(const command of [process.execPath,'/nonexistent/acceptance-worker']){
    const dir=mkdtempSync(join(tmpdir(),'bys-offline-supervisor-'));
    const report=await superviseWorker({command,args:['-e','throw Error("offline failure")'],dir,timeoutMs:300});
    assert.equal(report.process.overallExitCode,1);assert.equal(report.result.status,'BLOCKED');
  }
});
