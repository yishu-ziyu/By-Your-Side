import {expect,it} from 'vitest';
import {VoiceAudioCache} from '../src/voice-audio-cache.js';
it('limits reuse to fixed application receipts and discards oversized or empty audio',()=>{
 const cache=new VoiceAudioCache('tone');cache.put('任务已收到。',['AQABAA==']);expect(cache.get('任务已收到。')).toEqual(['AQABAA==']);
 for(const text of ['网页已经全部完成。','我看到了你的密码','任务已收到。任意额外文字']){cache.put(text,['AQABAA==']);expect(cache.get(text)).toBeUndefined();}
 cache.put('任务已终止。',[]);expect(cache.get('任务已终止。')).toBeUndefined();
 cache.put('任务已终止。',[Buffer.alloc(960002).toString('base64')]);expect(cache.get('任务已终止。')).toBeUndefined();
 const returned=cache.get('任务已收到。')!;returned[0]='changed';expect(cache.get('任务已收到。')).toEqual(['AQABAA==']);
});
