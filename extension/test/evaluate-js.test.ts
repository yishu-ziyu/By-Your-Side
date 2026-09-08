import {expect,it,vi} from 'vitest';
const command=vi.hoisted(()=>vi.fn());
vi.mock('../src/background/debugger.js',()=>({sendCommand:command}));
vi.mock('../src/background/state.js',()=>({resolveWorkingTab:async()=>({id:123})}));
import {evaluateJs} from '../src/background/exec/evaluate.js';
it('rejects an uninvoked function instead of presenting an empty object as execution evidence',async()=>{
 command.mockResolvedValueOnce({result:{type:'function',value:{},description:'() => {}'}});
 await expect(evaluateJs({code:'() => document.title'})).rejects.toThrow('函数体没有执行');
 command.mockResolvedValueOnce({result:{type:'object',value:{title:'test'}}});
 expect(await evaluateJs({code:'(() => ({title:document.title}))()'})).toEqual({value:{title:'test'}});
});
