import {sendCommand} from './debugger.js';

/** Native input values and backend identities include closed shadow roots.
 * Uncovered OOPIF documents fail closed; never substitute a top-document hash.
 */
export async function nativeApprovalState(tabId:number):Promise<string> {
  const tree=await sendCommand<{frameTree?:FrameTree}>(tabId,'Page.getFrameTree');
  const frames:string[]=[];
  const walk=(node:FrameTree)=>{frames.push(node.frame.id);for(const child of node.childFrames??[])walk(child);};
  if(!tree.frameTree)throw new Error('无法核对页面框架，操作未执行。');
  walk(tree.frameTree);
  const snapshot=await sendCommand<{strings:string[];documents:Array<Record<string,unknown>&{frameId:number}>}>(tabId,'DOMSnapshot.captureSnapshot',{computedStyles:[],includePaintOrder:false,includeDOMRects:false});
  if(!Array.isArray(snapshot.documents)||!Array.isArray(snapshot.strings))throw new Error('无法绑定原生页面状态，操作未执行。');
  const covered=new Set(snapshot.documents.map(doc=>snapshot.strings[doc.frameId]));
  if(frames.some(id=>!covered.has(id)))throw new Error('页面含无法完整绑定的子框架，请接管完成这一步。');
  const documents=snapshot.documents.map(({layout,textBoxes,scrollOffsetX,scrollOffsetY,contentWidth,contentHeight,...doc})=>doc);
  return JSON.stringify({frames:frames.sort(),strings:snapshot.strings,documents});
}
type FrameTree={frame:{id:string};childFrames?:FrameTree[]};
