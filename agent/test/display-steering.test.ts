/**
 * 运行中修改与显示工具的执行层边界。原 Jev 显示直达（decideDisplay）已随本机模式退役，
 * 这里只保留不依赖它的行为：模型未开始时合并成一条提示；显示工具只改本次要求的属性。
 */
import {describe,expect,it,vi} from 'vitest';

vi.mock('../src/run-trace.js',async(importOriginal)=>{
 const actual=await importOriginal<typeof import('../src/run-trace.js')>();

 return {...actual,RunTrace:class{begin(){}correlate(){}record(){}event(){}stage(){return{end(){}}}}};
});

import {context,pageHarness} from './fixtures/display-steering-harness.js';

describe('运行中修改（文字）',()=>{
 it('merges the requirement into one prompt only when the model has not started yet',async()=>{
  const h=pageHarness({streaming:false});
  let release!:()=>void;
  h.wrapper.displayWork=new Promise<void>(resolve=>{release=resolve;});
  h.wrapper.activeGoal='读取这篇文章';
  const steering=h.wrapper.steerCurrentTask('改成宋体',context);
  release();
  const outcome=await steering;
  expect(outcome).toEqual({kind:'model'});
  expect(h.raw.prompt).toHaveBeenCalledTimes(1);
  const promptText=h.raw.prompt.mock.calls[0]![0] as string;
  expect(promptText).toContain('原任务：读取这篇文章');
  expect(promptText).toContain('用户最新修改：改成宋体');
  expect(h.translationCalls).toHaveLength(0);
 });
});

describe('显示修改不得改变未指定属性（Ticket 7）',()=>{
 it('执行层：只带字体时不改模式，只带模式时不改字体，组合请求两项都生效',async()=>{
  const h=pageHarness();
  // 行1：仅译文＋原字体 → 只改宋体 → 仍为仅译文。
  await h.tool('page_translation').execute('row1',{action:'display',fontFamily:'songti',tabId:7,document:'one'});
  expect(h.pageState).toMatchObject({fontFamily:'songti',mode:'translated'});
  // 行2：双语＋宋体 → 再要求切回仅译文 → 字体仍是宋体（本夹具初始模式固定 translated，这里先显式切双语）。
  await h.tool('page_translation').execute('row2a',{action:'display',mode:'bilingual',tabId:7,document:'one'});
  expect(h.pageState).toMatchObject({fontFamily:'songti',mode:'bilingual'});
  await h.tool('page_translation').execute('row2b',{action:'display',mode:'translated',tabId:7,document:'one'});
  expect(h.pageState).toMatchObject({fontFamily:'songti',mode:'translated'});
  // 行4：明确组合请求两项都生效。
  await h.tool('page_translation').execute('row4',{action:'display',fontFamily:'songti',mode:'bilingual',tabId:7,document:'one'});
  expect(h.pageState).toMatchObject({fontFamily:'songti',mode:'bilingual'});
 });
});
