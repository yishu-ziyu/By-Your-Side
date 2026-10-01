import {beforeEach,expect,it,vi} from 'vitest';

const command=vi.hoisted(()=>vi.fn());

vi.mock('../src/background/debugger.js',()=>({sendCommand:command}));

vi.mock('../src/background/state.js',()=>({resolveWorkingTab:async()=>({id:123})}));

import {evaluateJs} from '../src/background/exec/evaluate.js';

// 页面脚本的执行事实（2026-10-01 GLM 实测：`return 1` 这类编译不过的脚本被记成「结果未知」，锁住后续步骤）。
// 失败方式：
// 1. 编译不过的脚本仍被发去运行，或报错没带 not_executed，被宿主当成「可能已改页面」；
// 2. 反向过宽：编译通过、运行到一半报错（已有副作用）却被记成 not_executed，可被自动重做；
// 3. 运行时抛出的 SyntaxError（如 JSON.parse）被当成编译错误。
// CDP 真实行为已在无头 Chrome 上实测：compileScript 需先 Runtime.enable；只编译不运行；语法与 evaluate 一致。
type Reply={result?:unknown;exceptionDetails?:unknown};

function cdp(replies:{compile?:Reply;evaluate?:Reply}){
  command.mockImplementation(async(_tab:number,method:string)=>{
    if(method==='Runtime.enable')return {};

    if(method==='Runtime.compileScript')return replies.compile??{};

    if(method==='Runtime.evaluate')return replies.evaluate??{result:{type:'undefined'}};
    throw new Error(`unexpected ${method}`);
  });
}

/** 等一个必然的失败，拿到错误本身（含 executionFact）。 */
async function failure(run:Promise<unknown>):Promise<Error>{
  try { await run; } catch (error) { if (error instanceof Error) return error; }

  throw new Error('expected an Error rejection');
}

const sent=(method:string)=>command.mock.calls.filter(call=>call[1]===method);

beforeEach(()=>{ command.mockReset(); });

it('rejects an uninvoked function instead of presenting an empty object as execution evidence',async()=>{
  cdp({evaluate:{result:{type:'function',value:{},description:'() => {}'}}});
  await expect(evaluateJs({code:'() => document.title'})).rejects.toThrow('函数体没有执行');
  cdp({evaluate:{result:{type:'object',value:{title:'test'}}}});
  expect(await evaluateJs({code:'(() => ({title:document.title}))()'})).toEqual({value:{title:'test'}});
});

it('1. a script that does not compile is never run and is reported as not executed',async()=>{
  cdp({compile:{exceptionDetails:{text:'Uncaught',exception:{className:'SyntaxError',description:'SyntaxError: Illegal return statement'}}}});
  const error=await failure(evaluateJs({code:'return 1'}));
  expect(error.message).toContain('SyntaxError: Illegal return statement');
  expect(error).toHaveProperty('executionFact','not_executed');
  expect(sent('Runtime.evaluate')).toHaveLength(0);
  expect(sent('Runtime.compileScript')[0]?.[2]).toMatchObject({expression:'return 1',persistScript:false});
});

it('2/3. a compiled script that throws while running (even a SyntaxError) keeps no not_executed fact',async()=>{
  cdp({evaluate:{exceptionDetails:{text:'Uncaught',exception:{className:'SyntaxError',description:"SyntaxError: Expected property name or '}' in JSON at position 1\n    at JSON.parse (<anonymous>)"}}}});
  const error=await failure(evaluateJs({code:'window.__y=1; JSON.parse("{")'}));
  expect(error.message).toContain('JSON');
  expect(error).not.toHaveProperty('executionFact','not_executed');
  expect(sent('Runtime.evaluate')).toHaveLength(1);
});
