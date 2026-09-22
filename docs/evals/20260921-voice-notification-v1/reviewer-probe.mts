// 独立评审探针：不依赖实现者测试，只从公开入口重放事件，断言 wire 消息与客户端回调。
import {EventEmitter} from 'node:events';
import {RealtimeVoiceConnection,MODEL,STEP_VOICE} from '/Users/mahaoxuan/Desktop/AI 产品/By-Your-Side/agent/src/realtime-voice-connection.js';

class Socket extends EventEmitter {readyState=1;sent:any[]=[];
  send(raw:string){try{this.sent.push(JSON.parse(raw));}catch{}}
  close(){this.readyState=3;}
  server(e:any){this.emit('message',Buffer.from(JSON.stringify(e)));}}

function fx(){
  const socket=new Socket();const client:any[]=[];
  const c=new RealtimeVoiceConnection({key:'x',connect:()=>socket as any,send:e=>client.push(e),log:()=>{},tools:{read_page:async()=>({ok:true,text:'p'}),task_status:async()=>({}),browser_request:async()=>({ok:true})}});
  c.start();
  socket.server({type:'session.created',session:{model:MODEL}});
  socket.server({type:'session.updated',session:{model:MODEL,voice:STEP_VOICE,input_audio_format:'pcm16',output_audio_format:'pcm16',turn_detection:{type:'server_vad'}}});

  return {socket,client,c};
}

const notices=(s:Socket)=>s.sent.filter(m=>String(m.item?.id??'').startsWith('bys-notice-'));

const creates=(s:Socket)=>s.sent.filter(m=>m.type==='response.create');

const ack=(s:Socket,i:number)=>s.server({type:'conversation.item.created',item:notices(s)[i].item});

const gen=(s:Socket,id:string,audio=false)=>{s.server({type:'response.created',response:{id}});

if(audio)s.server({type:'response.audio.delta',response_id:id,delta:Buffer.alloc(960).toString('base64')});s.server({type:'response.done',response:{id,status:'completed'}});};

const bindings=(c:any[])=>c.filter(e=>e.type==='delivery_response');

let pass=0,fail=0;

function check(name:string,cond:boolean,detail?:unknown){if(cond){pass++;console.log(`PASS ${name}`);}else{fail++;console.log(`FAIL ${name} :: ${JSON.stringify(detail)}`);}}

// X1: B 在 A 的确认到达之前入队（A 已上路，pendingNotice 等待 ACK 中）
{
  const {socket,client,c}=fx();
  c.notifyTask('A结果','delivery-a');
  c.notifyTask('B结果','delivery-b'); // A 的 ACK 还没到
  check('X1 只有A上路',notices(socket).length===1);
  ack(socket,0);
  check('X1 A确认后先为A请求回复',creates(socket).length===1&&notices(socket).length===1,{creates:creates(socket).length,notices:notices(socket).length});
  gen(socket,'resp-a',true);
  check('X1 A音频未播完B不上路',notices(socket).length===1);
  c.handle({type:'playback_done',responseId:'resp-a'});
  check('X1 A播完B上路',notices(socket).length===2);
  ack(socket,1);gen(socket,'resp-b',false);
  check('X1 各自绑定',JSON.stringify(bindings(client))===JSON.stringify([
    {type:'delivery_response',deliveryId:'delivery-a',responseId:'resp-a'},
    {type:'delivery_response',deliveryId:'delivery-b',responseId:'resp-b'}]),bindings(client));
  check('X1 总数 2/2',notices(socket).length===2&&creates(socket).length===2);
  check('X1 无error',!client.some(e=>e.type==='error'));
  c.close();
}

// X2: B 在 A 的确认到达之后入队（creatingNotice=A，created 未到）
{
  const {socket,client,c}=fx();
  c.notifyTask('A结果','delivery-a');
  ack(socket,0);
  c.notifyTask('B结果','delivery-b'); // A 已确认、回复创建中
  check('X2 B不能抢占',notices(socket).length===1&&creates(socket).length===1,{creates:creates(socket).length,notices:notices(socket).length});
  gen(socket,'resp-a',false);
  check('X2 A完成后B上路',notices(socket).length===2);
  ack(socket,1);gen(socket,'resp-b',false);
  check('X2 各自绑定',JSON.stringify(bindings(client))===JSON.stringify([
    {type:'delivery_response',deliveryId:'delivery-a',responseId:'resp-a'},
    {type:'delivery_response',deliveryId:'delivery-b',responseId:'resp-b'}]),bindings(client));
  check('X2 无error',!client.some(e=>e.type==='error'));
  c.close();
}

// X3: 相同文本，第二条在第一条 ACK 之前入队（文本去重误删检查，最紧时序）
{
  const {socket,client,c}=fx();
  c.notifyTask('相同文字');
  c.notifyTask('相同文字'); // 第一条还没确认
  check('X3 只发一条',notices(socket).length===1);
  ack(socket,0);gen(socket,'r1',false);
  check('X3 第二条随后上路',notices(socket).length===2);
  ack(socket,1);gen(socket,'r2',false);
  check('X3 两条各处理一次',notices(socket).length===2&&creates(socket).length===2,{creates:creates(socket).length});
  check('X3 无error',!client.some(e=>e.type==='error'));
  c.close();
}

// X4: 工具结果不被通知排队/播放状态阻塞（假修复类型4）
{
  const {socket,client,c}=fx();
  // 通知 A 在路上（ACK 未到，pendingNotice 阻塞窗口）
  c.notifyTask('通知A','delivery-a');
  // 用户话轮：server_vad 自动回复
  socket.server({type:'input_audio_buffer.speech_started',item_id:'u1'});
  socket.server({type:'input_audio_buffer.speech_stopped',item_id:'u1'});
  socket.server({type:'response.created',response:{id:'r1'}});
  socket.server({type:'response.audio.delta',response_id:'r1',delta:Buffer.alloc(480).toString('base64')}); // 前导语音频在播
  socket.server({type:'response.function_call_arguments.done',response_id:'r1',call_id:'call1',name:'read_page',arguments:'{}'});
  await Promise.resolve();await Promise.resolve();await Promise.resolve(); // 工具执行完成
  socket.server({type:'response.done',response:{id:'r1',status:'completed'}});
  const toolOut=socket.sent.some(m=>m.item?.type==='function_call_output');
  check('X4 工具结果不等 playback_done 即回传',toolOut===true,{sent:socket.sent.map(m=>m.type)});
  check('X4 未收到任何播放回执',true); // 本分支从未发 playback_done
  c.close();
}

// X5: 三条批量通知全按序处理、无吞掉（假修复类型1）
{
  const {socket,client,c}=fx();
  c.notifyTask('通知A','delivery-a');c.notifyTask('通知B');c.notifyTask('通知C','delivery-c');
  check('X5 只有第一条上路',notices(socket).length===1);
  ack(socket,0);gen(socket,'ra',false);
  check('X5 第二条上路',notices(socket).length===2);
  ack(socket,1);gen(socket,'rb',false);
  check('X5 第三条上路',notices(socket).length===3);
  ack(socket,2);gen(socket,'rc',false);
  check('X5 三条各自完成 3/3',notices(socket).length===3&&creates(socket).length===3);
  const texts=notices(socket).map(m=>m.item.content[0].text);
  check('X5 顺序与内容',texts[0].includes('通知A')&&texts[1].includes('通知B')&&texts[2].includes('通知C'),texts);
  check('X5 普通通知B无绑定、正式各绑定',bindings(client).length===2&&
    bindings(client)[0].deliveryId==='delivery-a'&&bindings(client)[0].responseId==='ra'&&
    bindings(client)[1].deliveryId==='delivery-c'&&bindings(client)[1].responseId==='rc',bindings(client));
  c.close();
}

// X6: 停声打断通知流程：通知被重新入队而不是被吞（假修复类型1 的停声变体）
{
  const {socket,client,c}=fx();
  c.notifyTask('通知A','delivery-a');
  ack(socket,0); // creatingNotice=A，等 created
  c.handle({type:'stop_speech'}); // 停声：pendingStop，created 还没到
  socket.server({type:'response.created',response:{id:'late'}});
  socket.server({type:'response.done',response:{id:'late',status:'cancelled'}});
  // 新的真实输入解锁
  c.handle({type:'text',text:'继续'});
  check('X6 停声后通知重新入队再播',notices(socket).length===2,{notices:notices(socket).length});
  c.close();
}

console.log(JSON.stringify({pass,fail}));

process.exit(fail?1:0);
