import {expect,it,vi} from 'vitest';
import {readVoicePage} from '../src/voice-page-reader.js';

const input={observation:{token:'lease',tabId:7}};

it('uses text observation and only returns text evidence, never screenshot data',async()=>{
 const call=vi.fn(async()=>({text:'Repository facts',url:'https://example.test',title:'Repo',scope:'viewport',capturedAt:123,imageBase64:'private-image'}));
 const result=await readVoicePage({call},input);
 expect(call).toHaveBeenCalledWith('observe_page',{token:'lease',mode:'text'},8000);
 expect(result).toMatchObject({ok:true,text:'Repository facts',scope:'viewport'});
 expect(result).not.toHaveProperty('imageBase64');
});

it('requires this turn observation grant before calling the browser',async()=>{
 const call=vi.fn();await expect(readVoicePage({call},{})).rejects.toThrow('权限');expect(call).not.toHaveBeenCalled();
});

it.each([undefined,{}, {text:''},{text:'  '}])('never treats missing text as a successful read',async(value)=>{
 await expect(readVoicePage({call:async()=>value},input)).rejects.toThrow();
});

it('preserves the actual page failure rather than reporting a successful tool return',async()=>{
 await expect(readVoicePage({call:async()=>{throw new Error('页面文档在读取期间已切换');}},input)).rejects.toThrow('已切换');
});
