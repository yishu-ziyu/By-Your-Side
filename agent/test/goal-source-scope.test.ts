import {afterEach,expect,it,vi} from 'vitest';
import {reviewTaskGoal} from '../src/goal-reasoning-review.js';

vi.mock('../src/typesafe-auth.js',()=>({readTypeSafeKey:()=> 'unit-test-key'}));
afterEach(()=>vi.unstubAllGlobals());
const first='Jev currently accepts text input only.';
const last='Images are not supported.';
const body=`${first} It evaluates strings. ${last}`;
const other='System 1 is intuitive. System 2 is deliberate.';
const url='https://fixture.test/source';

async function check(value:string,part='first_sentence',relation='initial',container=body,confidence=.99) {
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({answers:{matched:{noul:.96},problem:{choice:'none',confidence:.99},part:{choice:part,confidence},source:{choice:relation,confidence:.99}}}),{status:200})));
  const completeSimple=vi.fn();
  const result=await reviewTaskGoal({runtime:{completeSimple} as never,model:{} as never,sessionId:'test',headers:undefined},'source',{
    requirements:[relation==='same'?'改成同一个 Note 的最后一句':'取 Note 第一句'],
    observation:{url,text:container,fragments:{truncated:false,fragments:[{id:'note',kind:'text',text:container}]}},
    material:{value,selection:{kind:'fragments',ids:['note']},observation:{url}},
    previousSources:relation==='same'?[{value:first,sourceText:body,purpose:'原 Note',observation:{url}}]:[],
  },new AbortController().signal);
  return {result,completeSimple};
}

it('overconfident whole-node approval cannot satisfy a first-sentence request',async()=>{
  const {result,completeSimple}=await check(body);
  expect(result).toMatchObject({matched:false,reviewedBy:'code',issue:{kind:'wrong_range'}});
  expect(completeSimple).not.toHaveBeenCalled();
  expect((await check(first)).result.matched).toBe(true);
});

it('same-source amendments reject another Note, while the real original last sentence passes',async()=>{
  expect((await check('System 2 is deliberate.','last_sentence','same',other)).result).toMatchObject({matched:false,issue:{kind:'wrong_object'}});
  expect((await check(last,'last_sentence','same')).result).toMatchObject({matched:true,reviewedBy:'code'});
});

it('uncertain scope cannot silently fall back to approval by another model',async()=>{
  const {result,completeSimple}=await check(body,'first_sentence','initial',body,.5);
  expect(result).toMatchObject({matched:false,issue:{kind:'uncertain_scope'}});
  expect(completeSimple).not.toHaveBeenCalled();
});

it('a source URL is not silently accepted as part of the captured sentence',async()=>{
  expect((await check(`${first}\n${url}`)).result).toMatchObject({matched:false,issue:{kind:'wrong_range'}});
});

it('does not impose a sentence boundary on a supporting source for a general question',async()=>{
  expect((await check(body,'other','initial',body,.77)).result.matched).toBe(true);
});
