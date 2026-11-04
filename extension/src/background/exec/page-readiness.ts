import type {NavigationDownload,PageReadinessValue} from "../../../../shared/protocol.js";
import {overlayHostSelector} from "../../shared/overlay.js";
import {sendCommand} from "../debugger.js";
import {withTimeout} from "../timeout.js";
import {isRestrictedPage} from '../../../../shared/restricted-page.js';

export interface PageReadiness {
  readiness:PageReadinessValue;
  documentId?:string;
  waitMs:number;
  quietMs?:number;
  retryMs?:number;
  download?:NavigationDownload;
}

async function probeDocument(tabId:number):Promise<{doc:{documentId:string;url:string;readyState:DocumentReadyState}|null;error?:string}> {
  try {
    const [frame]=await chrome.scripting.executeScript({target:{tabId},injectImmediately:true,world:'ISOLATED',func:()=>({url:location.href,readyState:document.readyState})});

    return {doc:frame?.documentId&&frame.result?{documentId:frame.documentId,...frame.result}:null};
  } catch (error) { return {doc:null,error:error instanceof Error?error.message:String(error)}; }
}

export async function readCurrentDocument(tabId:number) {
  return (await probeDocument(tabId)).doc;
}

function unscriptableByDesign(url:string|undefined):boolean { return isRestrictedPage(url) || url === 'about:blank'; }

export const ERROR_PAGE_NOTE="Chrome shows its own error page for this address (for example the site could not be reached); the page did not open.";

const TRANSIENT_NET_ERRORS=new Set(['ERR_CONNECTION_CLOSED','ERR_CONNECTION_RESET','ERR_CONNECTION_REFUSED','ERR_CONNECTION_FAILED','ERR_CONNECTION_TIMED_OUT','ERR_TIMED_OUT','ERR_EMPTY_RESPONSE','ERR_NETWORK_CHANGED','ERR_INTERNET_DISCONNECTED']);

const RETRY_DELAY_MS=1000;

async function readNetErrorName(tabId:number):Promise<string|undefined> {
  try{
    const reply=await sendCommand<{result?:{value?:unknown}}>(tabId,'Runtime.evaluate',{expression:"location.protocol==='chrome-error:'?(document.querySelector('.error-code')?.textContent??''):''",returnByValue:true},undefined,1500);
    const name=typeof reply?.result?.value==='string'?reply.result.value.trim().replace(/^net::/,''):'';

    return /^ERR_[A-Z0-9_]+$/.test(name)?name:undefined;
  }catch{return undefined;}
}

async function tabAfterWait(tabId:number,errorUrl:string|undefined,error:string):Promise<'changed'|'reloading'|'error_page'> {
  const tab=await chrome.tabs.get(tabId).catch(()=>null);
  let where='';

  try{where=new URL(errorUrl??'').href;}catch{return 'changed';}

  if(!tab||!sameUrl(tab.pendingUrl??tab.url,where))return 'changed';

  if(tab.status==='complete'&&!tab.pendingUrl&&await readNetErrorName(tabId)===error)return 'error_page';

  return 'reloading';
}

export async function retryTransientErrorPage(tabId:number,url:string,ready:PageReadiness,timeoutMs:number,cancelled?:()=>boolean):Promise<{ready:PageReadiness;retry?:string}> {
  if(ready.readiness!=='error_page')return {ready};
  const error=await readNetErrorName(tabId);

  if(!error||!TRANSIENT_NET_ERRORS.has(error))return {ready};
  const errorUrl=(await chrome.tabs.get(tabId).catch(()=>null))?.url;
  const first=`The first attempt hit ${error} (a one-off network error)`;
  const userTookOver={ready,retry:`${first}; it was not retried because the user took over the page or the task stopped.`};

  for(const started=Date.now();Date.now()-started<RETRY_DELAY_MS;){
    if(cancelled?.())return userTookOver;
    await new Promise(resolve=>setTimeout(resolve,100));
  }

  if(cancelled?.())return userTookOver;
  const state=await tabAfterWait(tabId,errorUrl,error);

  if(state==='changed')return {ready,retry:`${first}; it was not retried because the page changed while waiting.`};
  const budget=Math.max(RETRY_DELAY_MS,timeoutMs-ready.waitMs-RETRY_DELAY_MS);

  if(state==='reloading'){
    const reloaded=await waitForInteractive(tabId,budget,{requestedUrl:url});

    reloaded.retryMs=reloaded.waitMs+RETRY_DELAY_MS;
    reloaded.waitMs+=ready.waitMs+RETRY_DELAY_MS;

    return {ready:reloaded,retry:reloaded.readiness==='interactive'||reloaded.readiness==='complete'?`${first}; the page then reloaded by itself and opened.`
      :reloaded.readiness==='error_page'?`${first}; the page then reloaded by itself and still failed.`
      :`${first}; the page then reloaded by itself; result: document ${reloaded.readiness}.`};
  }

  if(cancelled?.())return userTookOver;
  const again=await waitForInteractive(tabId,budget,{requestedUrl:url,dispatch:()=>chrome.tabs.update(tabId,{url})});

  again.retryMs=again.waitMs+RETRY_DELAY_MS;
  again.waitMs+=ready.waitMs+RETRY_DELAY_MS;
  const head=`${first}, so it was retried once automatically`;

  return {ready:again,retry:again.readiness==='interactive'||again.readiness==='complete'?`${head}; the retry succeeded.`
    :again.readiness==='error_page'?`${head}; the retry also failed.`
    :`${head}; the retry's result: document ${again.readiness}.`};
}

const ERROR_PAGE=/showing error page/i;

const DOWNLOAD_SETTLE_MS=3000;

const sameUrl=(a:string|undefined,b:string)=>{
  if(!a)return false;

  try{return new URL(a).href===b;}catch{return false;}
};

async function settleDownload(id:number,settleMs=DOWNLOAD_SETTLE_MS):Promise<NavigationDownload> {
  const deadline=Date.now()+settleMs;
  let item:chrome.downloads.DownloadItem|undefined;

  for(;;){
    item=(await Promise.resolve(chrome.downloads.search({id})).catch(()=>[]))[0]??item;

    if(!item||item.state!=='in_progress'||Date.now()>=deadline)break;
    await new Promise(resolve=>setTimeout(resolve,150));
  }

  if(!item)return {filename:'(no name yet)',path:'',state:'in_progress'};
  const base=item.filename.split(/[\\/]/).pop()||(()=>{try{return decodeURIComponent(new URL(item.finalUrl||item.url).pathname.split('/').pop()??'');}catch{return '';}})();

  return {
    filename:base||'(no name yet)',
    path:item.filename,
    state:item.state as NavigationDownload['state'],
    bytes:item.state==='complete'?(item.fileSize>=0?item.fileSize:item.bytesReceived):undefined,
    error:item.error,
    danger:item.danger&&item.danger!=='safe'&&item.danger!=='accepted'?item.danger:undefined,
  };
}

export function downloadNote(d:NavigationDownload,tab:'stays'|'closed'='stays'):string {
  const where=tab==='closed'?'Chrome closed the new tab it had opened for it':'the tab stays on its current page';
  const head=`This address started a download instead of opening a page; ${where}. Download "${d.filename}"`;

  if(d.state==='complete')return `${head}: Chrome's downloads API reports it complete, saved to ${d.path}${d.bytes!==undefined?` (${d.bytes} B)`:''}.`;

  if(d.state==='interrupted')return `${head}: Chrome reports it failed (${d.error??'interrupted'}); no complete file was saved.`;

  if(d.danger)return `${head}: Chrome flagged it as ${d.danger} and holds it until the user chooses Keep in Chrome's downloads. Not saved yet.`;

  return `${head}: Chrome has not reported it finished yet, so it is not saved yet.`;
}

export async function waitForInteractive(tabId:number,timeoutMs:number,options:{previousDocumentId?:string;requestedUrl?:string;dispatch?:()=>Promise<unknown>}={}):Promise<PageReadiness> {
  const {previousDocumentId}=options;
  const started=Date.now();let stopped=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let requested='';

  try{requested=options.requestedUrl?new URL(options.requestedUrl).href:'';}catch{}

  let onDownload:((item:chrome.downloads.DownloadItem)=>void)|undefined;
  let onTab:((id:number,info:chrome.tabs.OnUpdatedInfo,tab:chrome.tabs.Tab)=>void)|undefined;
  let downloadId:number|undefined;

  const download=new Promise<PageReadiness>(resolve=>{
    if(!requested||!chrome.downloads?.onCreated)return;
    let found=false;
    const take=(item:chrome.downloads.DownloadItem)=>{
      if(found||stopped||!(sameUrl(item.url,requested)||sameUrl(item.finalUrl,requested)))return;
      found=true;
      downloadId=item.id;
      void settleDownload(item.id).then(d=>resolve({readiness:'download',download:d,waitMs:Date.now()-started}));
    };
    onDownload=take;
    chrome.downloads.onCreated.addListener(take);
    if(!options.dispatch)void Promise.resolve(chrome.downloads.search({startedAfter:new Date(started-1000).toISOString()})).then(items=>items.forEach(take),()=>{});
  });

  const loaded=new Promise<PageReadiness>(resolve=>{
    let loading=false;
    onTab=(id,info,tab)=>{
      if(id!==tabId||stopped)return;

      if(info.status==='loading'){loading=true;return;}

      if(info.status!=='complete'||!loading||(tab.url==='about:blank'&&requested!=='about:blank'))return;
      void probeDocument(tabId).then(({doc,error})=>{
        if(stopped)return;

        if(doc){
          if(doc.documentId!==previousDocumentId)resolve({readiness:'complete',documentId:doc.documentId,waitMs:Date.now()-started});

          return;
        }

        if(error&&ERROR_PAGE.test(error))resolve({readiness:'error_page',waitMs:Date.now()-started});
        else if(unscriptableByDesign(tab.url))resolve({readiness:'complete',waitMs:Date.now()-started});
      });
    };
    chrome.tabs.onUpdated.addListener(onTab);
  });

  const timeout=new Promise<PageReadiness>(resolve=>{timer=setTimeout(()=>{
    stopped=true;

    if(downloadId===undefined){resolve({readiness:'timeout',waitMs:Date.now()-started});return;}
    void settleDownload(downloadId,0).then(d=>resolve({readiness:'download',download:d,waitMs:Date.now()-started}));
  },timeoutMs);});

  const poll=async():Promise<PageReadiness>=>{
    while(!stopped){
      const probe=await probeDocument(tabId);
      const first=probe.doc;

      if(stopped)break;

      if(!first&&probe.error&&ERROR_PAGE.test(probe.error)){
        const tab=await chrome.tabs.get(tabId).catch(()=>null);

        if(stopped)break;

        if(tab&&tab.status==='complete'&&!tab.pendingUrl&&(!requested||sameUrl(tab.url,requested)))return {readiness:'error_page',waitMs:Date.now()-started};
      }

      if(first&&first.documentId!==previousDocumentId&&first.url!=='about:blank'&&first.readyState!=='loading'){
        const second=await readCurrentDocument(tabId);

        if(stopped)break;
        const tab=await chrome.tabs.get(tabId);

        if(stopped)break;

        if(second?.documentId===first.documentId&&second.url===first.url&&second.readyState!=='loading'&&!tab.pendingUrl&&tab.url===second.url){
          return {readiness:second.readyState==='complete'?'complete':'interactive',documentId:second.documentId,waitMs:Date.now()-started};
        }
      }

      await new Promise(resolve=>setTimeout(resolve,100));
    }

    return {readiness:'timeout',waitMs:Date.now()-started};
  };

  try{
    await options.dispatch?.();

    return await Promise.race([poll(),download,loaded,timeout]);
  }
  finally{stopped=true;

if(timer)clearTimeout(timer);

if(onDownload)chrome.downloads.onCreated.removeListener(onDownload);

if(onTab)chrome.tabs.onUpdated.removeListener(onTab);}
}

const DOM_QUIET_MS=400;

const DOM_QUIET_BOUND_MS=3000;

export function settlesContent(readiness:PageReadinessValue|undefined):boolean {
  return readiness==='interactive'||readiness==='complete'||readiness==='timeout';
}

export async function waitForQuietDom(tabId:number):Promise<number> {
  const started=Date.now();
  const left=()=>DOM_QUIET_BOUND_MS-(Date.now()-started);
  const bounded=<T>(work:Promise<T>)=>withTimeout(work,Math.max(left(),0)+500,'DOM 安静等待超时');
  let target:{tabId:number;documentIds:string[]}|undefined;

  try{
    let documentId:string|undefined;

    for(;;){
      const doc=await bounded(readCurrentDocument(tabId));

      if(!doc||(documentId!==undefined&&doc.documentId!==documentId))return Date.now()-started;
      documentId=doc.documentId;

      if(doc.readyState!=='loading')break;

      if(left()<=0)return Date.now()-started;
      await new Promise(resolve=>setTimeout(resolve,Math.min(100,left())));
    }

    target={tabId,documentIds:[documentId]};
    await bounded(chrome.scripting.executeScript({target,injectImmediately:true,world:'ISOLATED',func:watchBodyInPage,args:[left(),overlayHostSelector()]}));

    while(left()>0){
      const [frame]=await bounded(chrome.scripting.executeScript({target,injectImmediately:true,world:'ISOLATED',func:readQuietInPage}));
      const state=frame?.result;

      if(!state||(state.quietMs>=DOM_QUIET_MS&&!state.empty))break;
      await new Promise(resolve=>setTimeout(resolve,Math.min(100,Math.max(left(),0))));
    }
  }catch{}
  finally{
    if(target)void chrome.scripting.executeScript({target,injectImmediately:true,world:'ISOLATED',func:stopWatchInPage}).catch(()=>{});
  }

  return Date.now()-started;
}

interface QuietDomState {last:number;stop:()=>void}

declare global {
  var __sideagentQuietDom:QuietDomState|undefined;
}

function watchBodyInPage(boundMs:number,ownSelector:string):void {
  globalThis.__sideagentQuietDom?.stop();
  const own=(node:Node)=>node instanceof Element&&!!node.closest(ownSelector);
  const inBody=(node:Node)=>!!document.body?.contains(node);
  const state:QuietDomState={last:performance.now(),stop:()=>{}};

  const mutations=new MutationObserver(records=>{
    if(records.some(r=>inBody(r.target)&&!own(r.target)&&!(r.type==='childList'&&[...r.addedNodes,...r.removedNodes].every(own))))state.last=performance.now();
  });

  mutations.observe(document,{subtree:true,childList:true,characterData:true});
  const bound=setTimeout(()=>state.stop(),boundMs+1000);

  state.stop=()=>{
    mutations.disconnect();
    clearTimeout(bound);

    if(globalThis.__sideagentQuietDom===state)delete globalThis.__sideagentQuietDom;
  };
  globalThis.__sideagentQuietDom=state;
}

function readQuietInPage():{quietMs:number;empty:boolean}|null {
  const state=globalThis.__sideagentQuietDom;

  if(!state)return null;
  const navigation=performance.getEntriesByType('navigation')[0];
  const contentLoaded=navigation instanceof PerformanceNavigationTiming?navigation.domContentLoadedEventEnd:state.last;
  const body=document.body;
  const empty=!!body&&!body.innerText.trim()&&!body.querySelector('a[href],button,input,select,textarea,img,svg,canvas,video,embed,object,iframe,frame');

  return {quietMs:contentLoaded>0?performance.now()-Math.max(state.last,contentLoaded):0,empty};
}

function stopWatchInPage():void {
  globalThis.__sideagentQuietDom?.stop();
}
