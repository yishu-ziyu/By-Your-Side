import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../src/typesafe-auth.js',()=>({readTypeSafeKey:()=> 'fixture-key'}));
import {decideBrowserCandidate} from '../src/browser-decision-model.js';
afterEach(()=>vi.unstubAllGlobals());
it('Jev receives off-viewport accessibility text plus the separate viewport, retaining both confidence distributions',async()=>{
 const fetch=vi.fn(async(_url:unknown,_options:{body:string})=>({ok:true,json:async()=>({answers:{operation:{choice:'click',confidence:.92,probabilities:{click:.96,done:.04}},click_target:{choice:'second',confidence:.87,probabilities:{first:.08,second:.91,none:.01}}}})}));vi.stubGlobal('fetch',fetch);
 const decision=await decideBrowserCandidate({goal:'选择第二项',page:{id:'obs',tabId:7,documentId:'doc',url:'https://fixture.test',observedAt:1,text:'完整无障碍树：评论最后一句在视口外',visibleText:'当前视口只有标题',controls:[],truncated:false,source:'accessibility'},materials:[],history:[],candidates:[{id:'first',operation:'click',label:'第一项',target:'@1'},{id:'second',operation:'click',label:'第二项',target:'@2'}]},new AbortController().signal);
 const body=JSON.parse(fetch.mock.calls[0]![1].body);
 expect(body.state.page.text).toContain('视口外');expect(body.state.page.visibleText).toBe('当前视口只有标题');
 expect(decision).toMatchObject({candidateId:'second',confidence:.87,operationConfidence:.92,targetConfidence:.87,operationProbabilities:{click:.96,done:.04},targetProbabilities:{first:.08,second:.91,none:.01}});
});
it('Jev none is a typed no_match decision, not a throw',async()=>{
 const fetch=vi.fn(async()=>({ok:true,json:async()=>({answers:{operation:{choice:'click',confidence:.91},click_target:{choice:'none',confidence:.88}},model:'jev-fixture'})}));
 vi.stubGlobal('fetch',fetch);
 const decision=await decideBrowserCandidate({goal:'找不到',page:{id:'obs',tabId:7,documentId:'doc',url:'https://fixture.test',observedAt:1,text:'x',controls:[],truncated:false,source:'accessibility'},materials:[],history:[],candidates:[{id:'first',operation:'click',label:'A',target:'@1'},{id:'second',operation:'click',label:'B',target:'@2'}]},new AbortController().signal);
 expect(decision).toMatchObject({candidateId:'none',confidence:.88,model:'jev-fixture'});
});
