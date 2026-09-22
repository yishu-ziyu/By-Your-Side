import type {VoiceInputContext} from '../../shared/voice.js';
import type {ToolRpc} from './rpc.js';

/** Realtime's read_page consumes text only. Never route it through screenshot consistency. */
export async function readVoicePage(rpc:Pick<ToolRpc,'call'>,input:VoiceInputContext):Promise<unknown>{
  if(!input.observation)throw new Error('本轮页面观察权限尚未就绪，请重新说明要查看的页面。');
  const value=await rpc.call('observe_page',{token:input.observation.token,mode:'text'},8000);

  if(!value||typeof value!=='object')throw new Error('页面没有返回有效资料。');
  const page=value as Record<string,unknown>;

  if(typeof page.text!=='string'||!page.text.trim())throw new Error('当前可见区域没有可读文字，未取得页面内容。');

  return {ok:true,text:page.text,url:page.url,title:page.title,scope:page.scope,capturedAt:page.capturedAt};
}
