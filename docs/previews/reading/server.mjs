/** Read-only preview of the production panel bundle with deterministic, local fixture messages. */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
const here=fileURLToPath(new URL('.',import.meta.url));
const dist=resolve(here,'../../../extension/dist');
const sample=await readFile(resolve(here,'sample.md'),'utf8');
const structured=await readFile(resolve(here,'sample-structured.md'),'utf8');
const mock=`
const listeners=[];
const storageListeners=[];
const readBag=()=>JSON.parse(localStorage.getItem('reading-preview-storage')??'{}');
const storage={get:async keys=>{const all=readBag();if(keys==null)return all;const names=typeof keys==='string'?[keys]:Array.isArray(keys)?keys:Object.keys(keys);return Object.fromEntries(names.map(k=>[k,all[k]]));},set:async values=>{const all=readBag();const changes={};for(const [k,v] of Object.entries(values)){changes[k]={oldValue:all[k],newValue:v};all[k]=v;}localStorage.setItem('reading-preview-storage',JSON.stringify(all));for(const fn of storageListeners)fn(changes,'local');},remove:async()=>{}};
globalThis.chrome={runtime:{getURL:p=>new URL('/'+p,location.href).href,connect:()=>({onMessage:{addListener:f=>listeners.push(f)},onDisconnect:{addListener:()=>{}},disconnect:()=>{},postMessage:()=>{}})},storage:{local:storage,session:storage,onChanged:{addListener:f=>storageListeners.push(f),removeListener:f=>{const i=storageListeners.indexOf(f);if(i>=0)storageListeners.splice(i,1);}}},tabs:{query:async()=>[{id:1,title:'截图中的长回答',url:'https://example.test/'}],onActivated:{addListener:()=>{}},onUpdated:{addListener:()=>{}},create:async()=>({id:2})}};
function emit(e){for(const listener of listeners)listener(e);}
const variant=new URLSearchParams(location.search).get('variant');
let activeVariant=variant??'after';
function setVariant(value){activeVariant=value;document.querySelector('#reading-candidate').disabled=true;for(const el of document.querySelectorAll('[data-delivery-id^="reading-"]'))el.style.display=el.dataset.deliveryId==='reading-'+value?'':'none';}
addEventListener('message',e=>{if(e.origin===location.origin&&e.data?.type==='reading-preview')setVariant(e.data.variant);});
addEventListener('DOMContentLoaded',()=>{
setVariant(variant);
const ready=setInterval(()=>{if(!listeners.length||!document.querySelector('#input'))return;clearInterval(ready);
emit({kind:'conversations',selectedConversationId:'default',conversations:[{id:'default',title:'新会话',createdAt:1,updatedAt:1,state:'idle',mode:'act'}]});
emit({kind:'conn',state:'connected'});
emit({kind:'server',msg:{type:'hello_ok',conversationId:'default',version:1,model:'opencode-go/deepseek-flash',models:[{id:'opencode-go/deepseek-flash',provider:'opencode-go',modelId:'deepseek-flash',name:'DeepSeek V4.1 Flash (Go)'}]}});
for(const [key,text] of Object.entries({before:${JSON.stringify(sample)},after:${JSON.stringify(structured)}})){
emit({kind:'server',msg:{type:'agent_event',conversationId:'default',event:{kind:'user_delivery',delivery:{id:'reading-'+key,conversationId:'default',runId:null,kind:'reply',text,status:'composed',composedAt:1}}}});
}
setVariant(activeVariant);
requestAnimationFrame(()=>{document.querySelector('#messages').scrollTop=0;});
},50);
});
`;
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'};
const server=createServer(async(req,res)=>{
 try {
 const name=new URL(req.url,'http://127.0.0.1').pathname;
 if(name==='/mock.js'){res.setHeader('Content-Type','text/javascript');res.end(mock);return;}
 if(name==='/panel.html'){
 let html=await readFile(resolve(dist,'sidepanel.html'),'utf8');
 html=html.replace('</head>','<link id="reading-candidate" rel="stylesheet" href="/candidate.css"></head>').replace('<script type="module"','<script src="/mock.js"></script><script type="module"');
 res.setHeader('Content-Type',mime['.html']);res.end(html);return;
 }
 const local=name==='/'?'preview.html':name==='/candidate.css'?'candidate.css':null;
 const file=local?resolve(here,local):resolve(dist,'.'+decodeURIComponent(name));
 if(!local&&!file.startsWith(dist+sep))throw Error('path');
 res.setHeader('Content-Type',mime[extname(file)]??'application/octet-stream');res.end(await readFile(file));
 }catch{res.statusCode=404;res.end('Not found');}
});
server.listen(Number(process.env.READING_PREVIEW_PORT??0),'127.0.0.1',()=>console.log('Reading preview: http://127.0.0.1:'+server.address().port));
