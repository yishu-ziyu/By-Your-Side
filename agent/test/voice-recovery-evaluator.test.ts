/** Boss-owned acceptance for direction-specific native framing and voice recovery. */
import {PassThrough} from 'node:stream';
import {describe,it,expect,vi} from 'vitest';
import {FrameDecoder,encodeFrame,createStdioTransport} from '../src/transport/stdio.js';

function incomingFrame(text:string){const body=Buffer.from(text),header=Buffer.alloc(4);header.writeUInt32LE(body.length);return Buffer.concat([header,body]);}
describe('Evaluator: native screenshot frames do not kill a healthy transport',()=>{
 it('decodes a fragmented >1MiB screenshot-shaped input and its following small frame',()=>{
  const payload=JSON.stringify({type:'tool_result',id:'shot',ok:true,data:{imageBase64:'A'.repeat(1200000)}});
  const bytes=Buffer.concat([incomingFrame(payload),incomingFrame('{"next":true}')]);
  const decoder=new FrameDecoder();const result:string[]=[];
  for(let i=0;i<bytes.length;i+=64000)result.push(...decoder.push(bytes.subarray(i,i+64000)));
  expect(result).toEqual([payload,'{"next":true}']);
 });
 it('keeps the production stdio transport alive after a large legitimate input',async()=>{
  const input=new PassThrough(),output=new PassThrough(),message=vi.fn(),close=vi.fn();
  const transport=createStdioTransport(input,output);transport.onMessage(message);transport.onClose(close);
  const payload=JSON.stringify({type:'tool_result',data:{imageBase64:'A'.repeat(1200000)}});
  input.write(incomingFrame(payload));input.write(incomingFrame('{"next":true}'));
  await new Promise(r=>setImmediate(r));
  expect(input.destroyed).toBe(false);expect(close).not.toHaveBeenCalled();expect(message.mock.calls.map(c=>c[0])).toEqual([payload,'{"next":true}']);
  input.destroy();output.destroy();
 });
 it('retains the 64MiB inbound header ceiling and the 1MiB outbound UTF8 ceiling',()=>{
  const valid=Buffer.alloc(4);valid.writeUInt32LE(64*1024*1024);expect(new FrameDecoder().push(valid)).toEqual([]);
  const invalid=Buffer.alloc(4);invalid.writeUInt32LE(64*1024*1024+1);expect(()=>new FrameDecoder().push(invalid)).toThrow();
  expect(encodeFrame('x'.repeat(1024*1024))).toHaveLength(1024*1024+4);
  expect(()=>encodeFrame('x'.repeat(1024*1024+1))).toThrow();expect(()=>encodeFrame('字'.repeat(350000))).toThrow();
 });
});
