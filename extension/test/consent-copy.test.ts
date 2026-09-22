import {describe,expect,it} from 'vitest';
import {consentDetailsText, consentHeading, consentStatusText, consentTargetText} from '../src/sidepanel/consent.js';
import type {FetchConsentRequest, WriteConsentRequest} from '../../shared/consent.js';

const fetchRequest: FetchConsentRequest = {id:'fetch-1',conversationId:'default',runId:'run-1',controlVersion:0,url:'https://example.test/api',method:'POST',headers:{'content-type':'application/json'},body:'{"n":1}',expiresAt:Date.now()+60_000};

const writeRequest: WriteConsentRequest = {kind:'write',id:'write-1',conversationId:'default',runId:'run-1',controlVersion:0,expiresAt:Date.now()+60_000,goal:'填写方案并保存',description:'填写 方案',tool:'fill',target:'#choice',value:'远山'};

describe('consent card copy',()=>{
  it('keeps fetch requests phrased as a network send',()=>{
    expect(consentHeading(fetchRequest,true)).toBe('允许发送这次请求吗？');
    expect(consentTargetText(fetchRequest)).toBe('POST https://example.test/api');
    expect(consentDetailsText(fetchRequest).summary).toBe('查看发送内容');
    expect(consentDetailsText(fetchRequest).content).toContain('请求头');
    expect(consentStatusText(fetchRequest,true)).toContain('不会发送');
  });

  it('describes the write confirmation as one exact action, with task, object and autosave warning',()=>{
    expect(consentHeading(writeRequest,true)).toBe('允许核对并在需要时重设这一项吗？');
    expect(consentHeading(writeRequest,false)).toBe('请求确认');
    expect(consentTargetText(writeRequest)).toBe('任务：填写方案并保存');
    const details=consentDetailsText(writeRequest);
    expect(details.summary).toBe('查看动作');
    expect(details.content).toContain('未确认的动作：填写 方案');
    expect(details.content).toContain('fill #choice = 远山');
    expect(details.content).toContain('若当前对象已经满足，不写入');
    expect(details.content).toContain('当前页面');
    expect(details.content).toContain('自动保存');
    expect(consentStatusText(writeRequest,true)).toContain('不会执行');
  });

  it('never claims permission while disconnected',()=>{
    expect(consentStatusText(writeRequest,false)).toContain('连接已断开');
    expect(consentStatusText(fetchRequest,false)).toContain('连接已断开');
  });
});
