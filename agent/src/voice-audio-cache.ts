const STATIC_SPEECH=[
 '任务已收到。','修改已送达当前任务。','修改已保存，继续后生效。','任务已暂停，页面现在归你。','已交还，原任务继续。','任务已终止。',
 '目前没有正在执行的任务。','任务还在执行，正在处理你的要求。','这一轮执行已经结束，结果还没有确认。','任务遇到了问题，请查看侧栏的错误记录。',
];
/** Only audio whose provider transcript matched application text may enter this bounded, in-memory cache. */
export class VoiceAudioCache {
 private entries=new Map<string,string[]>();
 constructor(private readonly voice:string){}
 private key(text:string){return `${this.voice}|pcm16|24000|speech-v1|${text}`;}
 private allowed(text:string){let rest=text.replaceAll('指定会话：','');for(const phrase of STATIC_SPEECH)rest=rest.replaceAll(phrase,'');return text.length>0&&text.length<=180&&rest==='';}
 get(text:string):string[]|undefined{const key=this.key(text),audio=this.entries.get(key);if(audio){this.entries.delete(key);this.entries.set(key,audio);}return audio?.slice();}
 put(text:string,audio:string[]):void{
  if(!this.allowed(text)||!audio.length||audio.reduce((sum,data)=>sum+Buffer.byteLength(data,'base64'),0)>960000)return;
  this.entries.set(this.key(text),audio.slice());while(this.entries.size>24)this.entries.delete(this.entries.keys().next().value!);
 }
}
