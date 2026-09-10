import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {VoiceCaptureStore,clearVoiceCapture,wavBuffer} from '../src/voice-capture-store.js';

const roots:string[]=[];
const tempRoot=():string=>{const root=mkdtempSync(join(tmpdir(),'voice-capture-'));roots.push(root);return root;};
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

const b64=(values:number[]):string=>Buffer.from(new Int16Array(values).buffer).toString('base64');
const lines=(root:string):any[]=>readdirSync(root).filter(name=>name.endsWith('.jsonl')).sort()
  .flatMap(name=>readFileSync(join(root,name),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
const wav=(path:string):{riff:string;wave:string;sampleRate:number;channels:number;bits:number;dataBytes:number;samples:number[]}=>{
  const buf=readFileSync(path);
  const data=buf.subarray(44);
  return {
    riff:buf.toString('ascii',0,4),wave:buf.toString('ascii',8,12),
    sampleRate:buf.readUInt32LE(24),channels:buf.readUInt16LE(22),bits:buf.readUInt16LE(34),dataBytes:buf.readUInt32LE(40),
    samples:Array.from(new Int16Array(data.buffer.slice(data.byteOffset,data.byteOffset+data.length))),
  };
};
const day=new Date(2026,8,10,12,0,0).getTime(); // local 2026-09-10
const DAY=24*60*60*1000;

describe('normal-use capture store',()=>{
  it('writes one JSONL line per fact and keeps audio in per-turn WAV files',()=>{
    const root=tempRoot();
    const store=new VoiceCaptureStore({root,now:()=>day});
    store.begin('v1','conv-1');
    store.record('v1','conv-1',{type:'ready',sampleRate:24000,maxSeconds:60});
    store.record('v1','conv-1',{type:'append',seq:1,eventId:'voice_a',turn:1,frame:0,samples:2,audio:b64([10,20])});
    store.record('v1','conv-1',{type:'append',seq:2,eventId:'voice_b',turn:1,frame:1,samples:2,audio:b64([30,40])});
    store.record('v1','conv-1',{type:'commit',seq:3,eventId:'voice_c',turn:1});
    store.record('v1','conv-1',{type:'item',turn:1,itemId:'item-1'});
    store.record('v1','conv-1',{type:'asr',turn:1,itemId:'item-1',outcome:'current',text:'打开邮箱'});
    store.record('v1','conv-1',{type:'forward',turn:1,itemId:'item-1',text:'打开邮箱'});
    store.command('v1','conv-1',{kind:'capture',turn:1,sampleRate:24000,data:b64([1,2,3,4])});
    store.command('v1','conv-1',{kind:'capture',turn:1,displayText:'你：打开邮箱'});
    store.command('v1','conv-1',{kind:'capture',turn:1,mark:true,note:'这条不对'});
    const written=lines(root);
    expect(written.map(line=>line.type)).toEqual(['ready','append','append','commit','item','asr','forward','c0','text','mark']);
    expect(written.every(line=>line.voiceId==='v1'&&line.conversationId==='conv-1'&&line.at===day)).toBe(true);
    expect(written.filter(line=>line.type!=='ready').every(line=>line.turn===1)).toBe(true);
    expect(written.find(line=>line.type==='ready')).toMatchObject({turn:null,sampleRate:24000,maxSeconds:60});
    // Audio is never inlined; each line points at the file it belongs to.
    expect(JSON.stringify(written)).not.toContain(b64([10,20]));
    const c0=written.find(line=>line.type==='c0')!;
    expect(c0).toMatchObject({sampleRate:24000,samples:4,seconds:0.0,path:join('audio','2026-09-10','v1-t1-c0.wav')});
    const commit=written.find(line=>line.type==='commit')!;
    expect(commit).toMatchObject({eventId:'voice_c',appended:2,samples:4,c1:join('audio','2026-09-10','v1-t1-c1.wav')});
    expect(written.find(line=>line.type==='text')).toMatchObject({source:'display',text:'你：打开邮箱'});
    expect(written.find(line=>line.type==='mark')).toMatchObject({note:'这条不对'});
    const c0Wav=wav(join(root,c0.path));
    expect(c0Wav).toMatchObject({riff:'RIFF',wave:'WAVE',sampleRate:24000,channels:1,bits:16,dataBytes:8});
    expect(c0Wav.samples).toEqual([1,2,3,4]);
    const c1Wav=wav(join(root,commit.c1));
    expect(c1Wav).toMatchObject({sampleRate:24000,channels:1,bits:16});
    expect(c1Wav.samples).toEqual([10,20,30,40]);
  });
  it('assembles C1 from the accepted append bytes of that turn only',()=>{
    const root=tempRoot();
    const store=new VoiceCaptureStore({root,now:()=>day});
    store.begin('v1','conv-1');
    store.record('v1','conv-1',{type:'append',seq:1,eventId:'voice_a',turn:1,frame:0,samples:2,audio:b64([1,1])});
    store.record('v1','conv-1',{type:'append',seq:2,eventId:'voice_b',turn:2,frame:0,samples:2,audio:b64([2,2])});
    store.record('v1','conv-1',{type:'append',seq:3,eventId:'voice_c',turn:2,frame:1,samples:2,audio:b64([3,3])});
    store.record('v1','conv-1',{type:'commit',seq:4,eventId:'voice_d',turn:2});
    const second=wav(join(root,'audio','2026-09-10','v1-t2-c1.wav'));
    expect(second.samples).toEqual([2,2,3,3]);
    expect(existsSync(join(root,'audio','2026-09-10','v1-t1-c1.wav'))).toBe(false);
    store.record('v1','conv-1',{type:'commit',seq:5,eventId:'voice_e',turn:1});
    expect(wav(join(root,'audio','2026-09-10','v1-t1-c1.wav')).samples).toEqual([1,1]);
    // A commit without appends is still recorded, with no audio claimed.
    store.record('v1','conv-1',{type:'commit',seq:6,eventId:'voice_f',turn:3});
    expect(lines(root).find(line=>line.type==='commit'&&line.eventId==='voice_f')).toMatchObject({appended:0,c1:null});
  });
  it('keeps an unattributable transcript instead of dropping it',()=>{
    const root=tempRoot();
    const store=new VoiceCaptureStore({root,now:()=>day});
    store.begin('v1','conv-1');
    store.record('v1','conv-1',{type:'asr',turn:null,itemId:'item-9',outcome:'unknown',text:'迟到的旧转写'});
    expect(lines(root).find(line=>line.type==='asr')).toMatchObject({turn:null,outcome:'unknown',text:'迟到的旧转写'});
  });
  it('deletes audio older than the retention age when a new session starts',()=>{
    const root=tempRoot();
    mkdirSync(join(root,'audio','2026-08-20'),{recursive:true});
    writeFileSync(join(root,'audio','2026-08-20','v0-t1-c0.wav'),wavBuffer(Buffer.alloc(4)));
    mkdirSync(join(root,'audio','2026-09-09'),{recursive:true});
    writeFileSync(join(root,'audio','2026-09-09','v0-t2-c0.wav'),wavBuffer(Buffer.alloc(4)));
    const log=vi.fn();
    new VoiceCaptureStore({root,now:()=>day,log}).begin('v1','conv-1');
    expect(existsSync(join(root,'audio','2026-08-20'))).toBe(false);
    expect(existsSync(join(root,'audio','2026-09-09'))).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('2026-08-20'));
  });
  it('deletes the oldest audio first once the size bound is exceeded',()=>{
    const root=tempRoot();
    const old=join(root,'audio','2026-09-01');
    mkdirSync(old,{recursive:true});
    const oldest=join(old,'a.wav'),newest=join(old,'b.wav');
    writeFileSync(oldest,wavBuffer(Buffer.alloc(600)));
    writeFileSync(newest,wavBuffer(Buffer.alloc(600)));
    const past=new Date(day-DAY);
    utimesSync(oldest,past,past);
    const log=vi.fn();
    new VoiceCaptureStore({root,now:()=>day,maxBytes:1000,log}).begin('v1','conv-1');
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(newest)).toBe(true);
    expect(statSync(newest).size).toBeLessThanOrEqual(1000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('已删除最旧的 1 个音频文件'));
  });
  it('records a write_failed gap instead of throwing when audio cannot be written',()=>{
    const root=tempRoot();
    writeFileSync(join(root,'audio'),'not a directory');
    const log=vi.fn();
    const store=new VoiceCaptureStore({root,now:()=>day,log});
    store.begin('v1','conv-1');
    expect(()=>store.command('v1','conv-1',{kind:'capture',turn:1,sampleRate:24000,data:b64([1,2])})).not.toThrow();
    const gap=lines(root).find(line=>line.type==='gap'&&line.code==='write_failed');
    expect(gap).toMatchObject({voiceId:'v1',conversationId:'conv-1',turn:1});
    expect(String(gap!.detail)).toContain('audio:');
    // The fact that C0 arrived is still recorded; only its audio path is missing.
    expect(lines(root).find(line=>line.type==='c0')).toMatchObject({path:null});
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('记录失败'));
  });
  it('logs instead of throwing when even the record file cannot be written',()=>{
    const root=tempRoot();
    writeFileSync(join(root,'blocked'),'x');
    const log=vi.fn();
    const store=new VoiceCaptureStore({root:join(root,'blocked','voice-capture'),now:()=>day,log});
    expect(()=>{store.begin('v1','conv-1');store.record('v1','conv-1',{type:'item',turn:1,itemId:'item-1'});}).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('记录失败'));
  });
  it('clears the capture contents while keeping the directory',()=>{
    const root=tempRoot();
    const store=new VoiceCaptureStore({root,now:()=>day});
    store.begin('v1','conv-1');
    store.command('v1','conv-1',{kind:'capture',turn:1,sampleRate:24000,data:b64([1,2])});
    const printed:any[]=[];
    const cleared=clearVoiceCapture(root,(message:string)=>printed.push(message));
    expect(cleared.paths.length).toBeGreaterThan(0);
    expect(cleared.bytes).toBeGreaterThan(0);
    expect(existsSync(root)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
    expect(printed.some(message=>message.includes('已删除'))).toBe(true);
  });
});
