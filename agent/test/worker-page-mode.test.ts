import {expect,it} from 'vitest';
import {workerSystemPrompt} from '../src/prompt.js';
it('distinguishes an exclusive worker page from a shared page before tool instructions',()=>{
 expect(workerSystemPrompt({id:'w',peers:[],tabId:1})).toContain('Your working page is exclusive');
 expect(workerSystemPrompt({id:'w',peers:[],tabId:1,shared:true})).toContain('Your working page is explicitly shared');
});
