// Boss-owned: replay must not change a previously delivered answer.
import {it,expect} from 'vitest';
import {PanelHistory} from '../src/background/panel-history.js';
function item(extra:any={}){return {kind:'server',msg:{type:'agent_event',conversationId:'default',event:{kind:'user_delivery',delivery:{conversationId:'default',id:'message-one',runId:'run-one',kind:'finding',text:'仅读标题，正文未开。',composedAt:100,status:'composed',...extra}}}} as any;}
it('duplicate status events preserve original content and never regress playback',()=>{const h=new PanelHistory();h.record(item());h.record(item({status:'played'}));h.record(item({status:'composed'}));h.record(item({status:'played',text:'正文已经核实',runId:'wrong-run'}));const rows=h.since();expect(rows).toHaveLength(1);const d=(rows[0]!.item as any).msg.event.delivery;expect(d).toMatchObject({text:'仅读标题，正文未开。',runId:'run-one',status:'played'});});
