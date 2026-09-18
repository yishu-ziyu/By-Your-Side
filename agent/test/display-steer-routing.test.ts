/**
 * Ticket 1: the Jev display judgment must return a typed result the new callers can act on —
 * candidate (no execution right), fallback (with an optional partial-scope observation), or cancelled —
 * and must stay behind an independent, default-off steering switch.
 *
 * These tests exercise the real module; only the config file and the HTTP boundary are replaced.
 * They assert request/response boundaries, not prompt wording or private fields.
 */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const configState=vi.hoisted(()=>({value:{} as Record<string,unknown>}));
vi.mock('../src/config.js',()=>({loadConfig:()=>configState.value}));

import {composeDisplayDecision,decideDisplay,displayFastPathEnabled,displaySteerFastPathEnabled} from '../src/display-fast-path.js';

const baseAnswers=(over:Record<string,unknown>={})=>({
  direct:{noul:.99},
  extra:{noul:0},
  partial:{noul:0},
  font:{choice:'unspecified',probabilities:{}},
  mode:{choice:'unspecified',probabilities:{}},
  ...over,
});
const fontSongti={choice:'songti',probabilities:{songti:.96,original:.02,unspecified:.02}};
const fontOriginal={choice:'original',probabilities:{songti:.05,original:.93,unspecified:.02}};
const modeTranslated={choice:'translated',probabilities:{bilingual:.04,translated:.95,unspecified:.01}};
const modeBilingual={choice:'bilingual',probabilities:{bilingual:.97,translated:.02,unspecified:.01}};

const okResponse=(answers:unknown)=>({ok:true,status:200,json:async()=>({answers})});
const fetchMock=vi.fn();

beforeEach(()=>{
  fetchMock.mockReset();
  vi.stubGlobal('fetch',fetchMock);
  process.env.TYPESAFE_API_KEY='test-key';
  delete process.env.SIDEAGENT_DISPLAY_FASTPATH;
  delete process.env.SIDEAGENT_DISPLAY_STEER_FASTPATH;
  configState.value={};
});
afterEach(()=>{
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.SIDEAGENT_DISPLAY_FASTPATH;
  delete process.env.SIDEAGENT_DISPLAY_STEER_FASTPATH;
});

describe('composeDisplayDecision',()=>{
  it('returns a candidate for one explicit supported parameter',()=>{
    expect(composeDisplayDecision(baseAnswers({font:fontSongti}),true)).toEqual({kind:'candidate',params:{action:'display',fontFamily:'songti'},reason:'accepted'});
  });
  it('returns a candidate for font plus mode together and never fills in a missing default',()=>{
    const decision=composeDisplayDecision(baseAnswers({font:fontSongti,mode:modeTranslated}),true);
    expect(decision).toEqual({kind:'candidate',params:{action:'display',fontFamily:'songti',mode:'translated'},reason:'accepted'});
    const modeOnly=composeDisplayDecision(baseAnswers({mode:modeTranslated}),true) as unknown as {params:Record<string,unknown>};
    expect(modeOnly.params).toEqual({action:'display',mode:'translated'});
    expect(modeOnly.params).not.toHaveProperty('fontFamily');
  });
  it('refuses answers with missing or invalid judgments',()=>{
    expect(composeDisplayDecision({},true)).toEqual({kind:'fallback',reason:'invalid_response'});
    expect(composeDisplayDecision(baseAnswers({direct:{noul:1.5}}),true)).toMatchObject({kind:'fallback',reason:'invalid_response'});
    expect(composeDisplayDecision(baseAnswers({font:{choice:'arial',probabilities:{arial:.99}}}),true)).toMatchObject({kind:'fallback',reason:'invalid_response'});
    expect(composeDisplayDecision(baseAnswers({font:{choice:'songti',probabilities:{songti:1.5}}}),true)).toMatchObject({kind:'fallback',reason:'font_uncertain'});
  });
  it('refuses uncertain or out-of-scope requests without producing executable parameters',()=>{
    expect(composeDisplayDecision(baseAnswers({direct:{noul:.5}}),true)).toMatchObject({kind:'fallback',reason:'direct_uncertain'});
    expect(composeDisplayDecision(baseAnswers({extra:{noul:.9}}),true)).toMatchObject({kind:'fallback',reason:'extra_or_uncertain'});
    expect(composeDisplayDecision(baseAnswers({partial:{noul:.9}}),true)).toEqual({kind:'fallback',reason:'partial_or_uncertain',partialScope:true});
    expect(composeDisplayDecision(baseAnswers({font:{choice:'songti',probabilities:{songti:.6}}}),true)).toMatchObject({kind:'fallback',reason:'font_uncertain'});
    expect(composeDisplayDecision(baseAnswers(),true)).toMatchObject({kind:'fallback',reason:'no_positive_change'});
    expect(composeDisplayDecision(baseAnswers(),false)).toMatchObject({kind:'fallback',reason:'no_translation'});
    expect(composeDisplayDecision(baseAnswers({font:fontOriginal}),true)).toEqual({kind:'fallback',reason:'unsupported_original_font'});
  });
  it('keeps the partial-scope observation on an otherwise ordinary fallback',()=>{
    expect(composeDisplayDecision(baseAnswers({partial:{noul:.5}}),true)).toEqual({kind:'fallback',reason:'partial_or_uncertain',partialScope:true});
    expect(composeDisplayDecision(baseAnswers({direct:{noul:.1},partial:{noul:.5}}),true)).toMatchObject({kind:'fallback',reason:'direct_uncertain',partialScope:true});
    expect(composeDisplayDecision(baseAnswers({extra:{noul:.9},partial:{noul:0}}),true)).toEqual({kind:'fallback',reason:'extra_or_uncertain'});
  });
});

describe('decideDisplay request boundary',()=>{
  it('calls the fixed model once and returns the candidate for explicit supported parameters',async()=>{
    fetchMock.mockResolvedValue(okResponse(baseAnswers({font:fontSongti,mode:modeBilingual})));
    const result=await decideDisplay('把译文改成宋体并切回双语',new AbortController().signal);
    expect(result).toEqual({kind:'candidate',params:{action:'display',fontFamily:'songti',mode:'bilingual'},reason:'accepted'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url,init]=fetchMock.mock.calls[0] as [string,{headers:Record<string,string>;body:string}];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    const body=JSON.parse(init.body);
    expect(body.model).toBe('jev-1.13.0');
    expect(body.state.request).toBe('把译文改成宋体并切回双语');
    expect(body.state.hasExistingTranslation).toBe(true);
    expect(Object.keys(body.questions)).toEqual(expect.arrayContaining(['direct','extra','partial','font','mode']));
  });
  it('maps missing credentials, http failures, unreadable bodies and uncertain answers to non-executable results',async()=>{
    const emptyHome=mkdtempSync(join(tmpdir(),'sideagent-route-home-'));
    vi.stubEnv('HOME',emptyHome);
    delete process.env.TYPESAFE_API_KEY;
    expect(await decideDisplay('宋体',new AbortController().signal)).toEqual({kind:'fallback',reason:'missing_credentials'});
    expect(fetchMock).not.toHaveBeenCalled();
    rmSync(emptyHome,{recursive:true,force:true});
    process.env.TYPESAFE_API_KEY='test-key';

    fetchMock.mockResolvedValue({ok:false,status:503,json:async()=>({})});
    expect(await decideDisplay('宋体',new AbortController().signal)).toEqual({kind:'fallback',reason:'http_503'});

    fetchMock.mockResolvedValue({ok:true,status:200,json:async()=>{throw new Error('not json');}});
    expect(await decideDisplay('宋体',new AbortController().signal)).toEqual({kind:'fallback',reason:'invalid_response'});

    fetchMock.mockResolvedValue(okResponse({direct:{noul:.2}}));
    expect(await decideDisplay('宋体',new AbortController().signal)).toMatchObject({kind:'fallback',reason:'invalid_response'});
  });
  it('returns timeout when the single call exceeds its one-second budget',async()=>{
    fetchMock.mockImplementation((_url:unknown,init:{signal:AbortSignal})=>new Promise((_resolve,reject)=>{
      init.signal.addEventListener('abort',()=>reject(Object.assign(new Error('The operation was aborted.'),{name:'TimeoutError'})),{once:true});
    }));
    expect(await decideDisplay('宋体',new AbortController().signal)).toEqual({kind:'fallback',reason:'timeout'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },10_000);
  it('does not accept a response that arrived after the budget',async()=>{
    fetchMock.mockResolvedValue({ok:true,status:200,json:async()=>{
      await new Promise(resolve=>setTimeout(resolve,1050));
      return {answers:baseAnswers({font:fontSongti})};
    }});
    expect(await decideDisplay('宋体',new AbortController().signal)).toEqual({kind:'fallback',reason:'late_response'});
  },10_000);
  it('separates cancellation from an ordinary miss',async()=>{
    const pre=new AbortController();pre.abort();
    expect(await decideDisplay('宋体',pre.signal)).toEqual({kind:'cancelled'});
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockImplementation((_url:unknown,init:{signal:AbortSignal})=>new Promise((_resolve,reject)=>{
      init.signal.addEventListener('abort',()=>reject(Object.assign(new Error('The operation was aborted.'),{name:'AbortError'})),{once:true});
    }));
    const controller=new AbortController();
    const pending=decideDisplay('宋体',controller.signal);
    await new Promise(resolve=>setTimeout(resolve,10));
    controller.abort();
    expect(await pending).toEqual({kind:'cancelled'});
  });
});

describe('display fast-path switches',()=>{
  it('keeps the steering fast path off by default and follows the existing master switch',()=>{
    expect(displayFastPathEnabled()).toBe(false);
    expect(displaySteerFastPathEnabled()).toBe(false);

    configState.value={displaySteerFastPath:true};
    expect(displaySteerFastPathEnabled()).toBe(false);

    configState.value={displayFastPath:true};
    expect(displayFastPathEnabled()).toBe(true);
    expect(displaySteerFastPathEnabled()).toBe(false);

    configState.value={displayFastPath:true,displaySteerFastPath:true};
    expect(displaySteerFastPathEnabled()).toBe(true);

    process.env.SIDEAGENT_DISPLAY_STEER_FASTPATH='0';
    expect(displaySteerFastPathEnabled()).toBe(false);

    delete process.env.SIDEAGENT_DISPLAY_STEER_FASTPATH;
    process.env.SIDEAGENT_DISPLAY_FASTPATH='0';
    expect(displayFastPathEnabled()).toBe(false);
    expect(displaySteerFastPathEnabled()).toBe(false);

    process.env.SIDEAGENT_DISPLAY_FASTPATH='1';
    process.env.SIDEAGENT_DISPLAY_STEER_FASTPATH='1';
    expect(displaySteerFastPathEnabled()).toBe(true);
  });
});
