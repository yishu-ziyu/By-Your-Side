import {sendCommand} from './debugger.js';

/** Never fall back to MAIN: a page can install effectful getters there. */
export async function isolatedReadContext(tabId:number):Promise<number> {
  const tree=await sendCommand<{frameTree?:{frame?:{id?:string}}}>(tabId,'Page.getFrameTree');
  const frameId=tree.frameTree?.frame?.id;
  if(!frameId)throw new Error('无法建立隔离读取上下文，操作未执行。');
  const world=await sendCommand<{executionContextId?:number}>(tabId,'Page.createIsolatedWorld',{frameId,worldName:'sideagent-trusted-read',grantUniveralAccess:false});
  if(!Number.isInteger(world.executionContextId))throw new Error('隔离读取上下文不可用，操作未执行。');
  return world.executionContextId!;
}
