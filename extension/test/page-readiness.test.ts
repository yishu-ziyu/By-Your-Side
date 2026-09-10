import {afterEach,expect,it,vi} from 'vitest';
import {waitForInteractive} from '../src/background/exec/page-readiness.js';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
function setup(documents:Array<{id:string;state:string;url?:string}>){
 let i=0;const executeScript=vi.fn(async()=>{const d=documents[Math.min(i++,documents.length-1)]!;return [{documentId:d.id,result:{readyState:d.state,url:d.url??'https://example.test/'}}];});
 vi.stubGlobal('chrome',{scripting:{executeScript},tabs:{get:vi.fn(async()=>({url:'https://example.test/',status:'loading'}))}});return executeScript;
}
it('returns an interactive document while subresources are still loading',async()=>{
 setup([{id:'new',state:'interactive'}]);
 expect(await waitForInteractive(1,1000)).toMatchObject({readiness:'interactive',documentId:'new'});
});
it('does not accept the previous complete document on a same-URL navigation',async()=>{
 vi.useFakeTimers();setup([{id:'old',state:'complete'},{id:'new',state:'loading'},{id:'new',state:'interactive'}]);
 const p=waitForInteractive(1,1000,'old');await vi.advanceTimersByTimeAsync(400);
 expect(await p).toMatchObject({readiness:'interactive',documentId:'new'});
});
it('rejects a readiness sample superseded by a new document',async()=>{
 vi.useFakeTimers();setup([{id:'first',state:'interactive'},{id:'second',state:'loading'},{id:'second',state:'interactive'}]);
 const p=waitForInteractive(1,1000);await vi.advanceTimersByTimeAsync(400);
 expect(await p).toMatchObject({documentId:'second'});
});
it('reports timeout without claiming readiness and bounds a hung scripting call',async()=>{
 vi.useFakeTimers();vi.stubGlobal('chrome',{scripting:{executeScript:()=>new Promise(()=>{})}});
 const p=waitForInteractive(1,500);await vi.advanceTimersByTimeAsync(500);
 expect(await p).toMatchObject({readiness:'timeout'});
});
