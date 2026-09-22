// R2 同口径复测探针：ready 前排入两条带 deliveryId 的通知，重放第一批事件后读现场。
// 对照修前证据 docs/evals/20260921-voice-root-cause-audit/notice-batch-result.json
// （修前：A 确认后先发送 B 而不是为 A 请求回复，最终只有 delivery-2 绑定）。
import {EventEmitter} from 'node:events';
import {RealtimeVoiceConnection,MODEL,STEP_VOICE} from '../../../agent/src/realtime-voice-connection.js';

class Socket extends EventEmitter {readyState=1;sent:any[]=[];send(raw:string){try{this.sent.push(JSON.parse(raw));}catch{/* 测试 stub：非 JSON 帧丢弃 */}}close(){}server(e:any){this.emit('message',Buffer.from(JSON.stringify(e)));}}

const socket=new Socket();

const client:any[]=[];

const connection=new RealtimeVoiceConnection({key:'offline',connect:()=>socket as any,send:e=>client.push(e),log:()=>{},tools:{read_page:async()=>({}),task_status:async()=>({}),browser_request:async()=>({})}});

connection.start();

connection.notifyTask('A 的结果','delivery-1');

connection.notifyTask('B 的结果','delivery-2');

socket.server({type:'session.created',session:{model:MODEL}});

socket.server({type:'session.updated',session:{model:MODEL,voice:STEP_VOICE,input_audio_format:'pcm16',output_audio_format:'pcm16',turn_detection:{type:'server_vad'}}});

const notices=()=>socket.sent.filter(m=>String(m.item?.id??'').startsWith('bys-notice-'));

const first=notices()[0];

// 第一条通知得到确认
socket.server({type:'conversation.item.created',item:first.item});

const beforeCreate={notifications:notices().length,responseCreates:socket.sent.filter(m=>m.type==='response.create').length};

// 为第一条生成的回复抵达并结束
socket.server({type:'response.created',response:{id:'reply-a'}});

socket.server({type:'response.done',response:{id:'reply-a',status:'completed'}});

// 第二条通知得到确认并完成自己的回复
const second=notices()[1];

socket.server({type:'conversation.item.created',item:second.item});

socket.server({type:'response.created',response:{id:'reply-b'}});

socket.server({type:'response.done',response:{id:'reply-b',status:'completed'}});

console.log(JSON.stringify({
  beforeCreate,
  finalNotifications:notices().length,
  finalResponseCreates:socket.sent.filter(m=>m.type==='response.create').length,
  deliveryBindings:client.filter(e=>e.type==='delivery_response'),
},null,2));

connection.close();
