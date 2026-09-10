import {expect,it,vi} from 'vitest';
import {createBrowserTools} from '../src/tools.js';
import {WRITE_TOOLS} from '../../shared/control.js';

const execute = (tools:any[], name:string, params:any) => tools.find(t=>t.name===name).execute('access-check',params,undefined,undefined,{});
const entry = (program:boolean, code:string) => program
 ? {name:'browser_run',params:{code:`return await browser.js({code:${JSON.stringify(code)}});`}}
 : {name:'js',params:{code}};

for (const disabled of WRITE_TOOLS) for (const program of [false,true]) {
 it(`${program?'program':'direct'} JS cannot bypass disabled ${disabled}`,async()=>{
  const rpc={call:vi.fn(async()=>({value:true}))};
  const tools=createBrowserTools(rpc as any,undefined,undefined,name=>name!==disabled);
  const request=entry(program,'document.body.appendChild(document.createElement("aside")); return true;');
  await expect(execute(tools,request.name,request.params)).rejects.toThrow(/未启用|不可用/);
  expect(rpc.call).not.toHaveBeenCalled();
 });
}

it('restrictions are live; constrained reads survive and full-access JS recovers',async()=>{
 const disabled=new Set<string>();const rpc={call:vi.fn(async(name:string)=>name==='snapshot'?{text:'fixture'}:{value:42})};
 const tools=createBrowserTools(rpc as any,undefined,undefined,name=>!disabled.has(name));
 for(const program of [false,true]){
  const request=entry(program,'return 42;');
  await execute(tools,request.name,request.params);
  rpc.call.mockClear();disabled.add('mark');
  await expect(execute(tools,request.name,request.params)).rejects.toThrow(/mark/);
  await expect(execute(tools,request.name,request.params)).rejects.toThrow(/snapshot|read_element/);
  expect(rpc.call).not.toHaveBeenCalled();
  await execute(tools,'snapshot',{});await execute(tools,'read_element',{target:'body'});
  expect(rpc.call.mock.calls.map(c=>c[0])).toEqual(['snapshot','read_element']);
  rpc.call.mockClear();
  await execute(tools,'browser_run',{code:'return await browser.read_element({target:"body"});'});
  expect(rpc.call).toHaveBeenCalledWith('read_element',{target:'body'},undefined,undefined,'access-check');
  disabled.clear();rpc.call.mockClear();await execute(tools,request.name,request.params);
  expect(rpc.call).toHaveBeenCalledWith('js',{code:'return 42;'},undefined,undefined,...(program?['access-check']:[]));
 }
});

for(const program of [false,true])it(`full/default access and unrelated read restriction preserve ${program?'program':'direct'} JS`,async()=>{
 for(const canExecute of [undefined,()=>true,(name:string)=>name!=='screenshot']){
  const rpc={call:vi.fn(async()=>({value:42}))};const tools=createBrowserTools(rpc as any,undefined,undefined,canExecute);
  const request=entry(program,'return 42;');await execute(tools,request.name,request.params);
  expect(rpc.call).toHaveBeenCalledTimes(1);
 }
});
it('disabled capabilities cannot execute through the direct tool or the browser program wrapper',async()=>{
 const call=vi.fn(async()=>({marked:true}));const tools=(createBrowserTools as any)({call},undefined,undefined,(name:string)=>name!=='mark');
 const direct=tools.find((t:any)=>t.name==='mark');await expect(direct.execute('direct',{target:'#target'},undefined,undefined,{})).rejects.toThrow(/不可用|未启用/);
 const program=tools.find((t:any)=>t.name==='browser_run');await expect(program.execute('program',{code:'return await browser.mark({target:"#target"});'},undefined,undefined,{})).rejects.toThrow(/不可用|未启用/);expect(call).not.toHaveBeenCalled();
});
