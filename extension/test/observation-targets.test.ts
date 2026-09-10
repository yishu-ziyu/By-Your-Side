import {expect,it} from 'vitest';
import {axTreeToText,type AxNodeLite} from '../src/background/axtree.js';

it('every rendered content node can be addressed without guessing DOM structure',()=>{
  const roles=['heading','StaticText','image','button','listitem'];
  const nodes:AxNodeLite[]=roles.map((role,i)=>({nodeId:String(i),backendDOMNodeId:100+i,role:{value:role},name:{value:`内容${i}`}}));
  const snapshot=axTreeToText(nodes);
  for(let i=0;i<roles.length;i++)expect(snapshot.text).toContain(`[ref=${100+i}]`);
  expect(snapshot.backendIds).toEqual([100,101,102,103,104]);
});

it('only references actually delivered within the output budget are usable',()=>{
  const nodes:AxNodeLite[]=Array.from({length:2000},(_,i)=>({nodeId:String(i),backendDOMNodeId:i+1,role:{value:'button'},name:{value:'长文本'.repeat(40)}}));
  const snapshot=axTreeToText(nodes);
  expect(snapshot.truncated).toBe(true);
  expect(snapshot.backendIds).toEqual([...snapshot.text.matchAll(/\[ref=(\d+)\]/g)].map(m=>Number(m[1])));
});
