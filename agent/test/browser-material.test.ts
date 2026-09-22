import {expect,it} from 'vitest';
import {parseBrowserMaterial} from '../src/browser-material.js';

const input={goal:'Use the supplied text',userText:'Please enter 「Aurora」',control:{ref:'@1',role:'textbox',name:'Name',disabled:false}};

it('copies supplied text exactly and rejects invented user facts',()=>{
 expect(parseBrowserMaterial('{"kind":"ready","value":"Aurora","source":"user"}',input)).toMatchObject({kind:'ready',material:{value:'Aurora',source:'user'}});
 expect(parseBrowserMaterial('{"kind":"ready","value":"Other","source":"user"}',input).kind).toBe('missing');
});

it('allows requested composition without disguising it as original user text',()=>{expect(parseBrowserMaterial('{"kind":"ready","value":"A rewritten sentence","source":"generated"}',input)).toMatchObject({kind:'ready',material:{source:'generated'}});});

it.each(['not json','{"kind":"ready","value":"x","source":"generated","code":"click()"}','{"kind":"missing","reason":"Email was not supplied"}'])('never turns missing/invalid data into a write: %s',text=>{expect(parseBrowserMaterial(text,input).kind).toBe('missing');});

it('native option values must match observed selectable labels',()=>{
 const p={...input,control:{...input.control,role:'combobox',options:[{ref:'@2',label:'Known',disabled:false}]}};
 expect(parseBrowserMaterial('{"kind":"ready","value":"Imagined","source":"generated"}',p).kind).toBe('missing');
});
