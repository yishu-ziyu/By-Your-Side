import {EventEmitter} from 'node:events';
import {RealtimeVoiceConnection,MODEL,STEP_VOICE} from '../../../agent/src/realtime-voice-connection.js';

class Socket extends EventEmitter {readyState=1;sent:any[]=[];send(raw:string){this.sent.push(JSON.parse(raw));}close(){}server(e:any){this.emit('message',Buffer.from(JSON.stringify(e)));}}

const socket=new Socket();

const log:any[]=[];

const connection=new RealtimeVoiceConnection({key:'offline',connect:()=>socket as any,send:()=>{},log:e=>log.push(e),tools:{read_page:async()=>({}),task_status:async()=>({}),browser_request:async()=>({})}});

connection.start();

socket.server({type:'session.created',session:{model:MODEL}});

socket.server({type:'session.updated',session:{model:MODEL,voice:STEP_VOICE,input_audio_format:'pcm16',output_audio_format:'pcm16',turn_detection:{type:'server_vad'}}});

connection.notifyTask('当前任务状态：idle');

const first=socket.sent.find(m=>m.item?.type==='message'&&m.item?.content?.[0]?.text?.includes('【系统通知】'));

socket.server({type:'conversation.item.created',item:first.item});

socket.server({type:'response.created',response:{id:'one'}});

socket.server({type:'response.done',response:{id:'one',status:'completed'}});

const notices=socket.sent.filter(m=>m.item?.type==='message'&&m.item?.content?.[0]?.text?.includes('【系统通知】'));

console.log(JSON.stringify({externalNotifications:1,notificationsSent:notices.length,sameText:notices[0].item.content[0].text===notices[1]?.item.content[0].text,events:log.filter(e=>['notify_queued','notify_sent','response_created'].includes(String(e.type)))},null,2));

connection.close();
