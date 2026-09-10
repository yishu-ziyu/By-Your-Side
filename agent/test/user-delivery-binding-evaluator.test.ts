// Boss-owned validation of meaningful content and snapshot ownership.
import {it,expect} from 'vitest';
import {isUserDelivery,isSpeakableDelivery,isTaskProgressSnapshot,type UserDelivery} from '../../shared/voice.js';
const d:UserDelivery={conversationId:'default',id:'delivery-one',runId:'run-one',kind:'finding',text:'只看过标题，正文未开。',composedAt:100,status:'composed'};
const snapshot=(delivery:UserDelivery)=>({conversationId:'default',state:'idle',runId:'run-one',goal:'读标题',startedAt:10,observedAt:100,active:[],lastAction:null,successVerified:false,conversationContext:{recentTurns:[],latestResult:null,latestDelivery:delivery}});
it('whitespace is not a deliverable answer',()=>{expect(isUserDelivery({...d,text:' \n\t '})).toBe(false);});
it('a snapshot cannot carry another conversation or run as its current delivery',()=>{expect(isTaskProgressSnapshot(snapshot(d))).toBe(true);expect(isTaskProgressSnapshot(snapshot({...d,conversationId:'other'}))).toBe(false);expect(isTaskProgressSnapshot(snapshot({...d,runId:'old-run'}))).toBe(false);});
it('explicitly having no task run cannot select a former task finding for speech',()=>{expect(isSpeakableDelivery(d,null)).toBe(false);expect(isSpeakableDelivery({...d,runId:null,kind:'reply'},null)).toBe(true);});
