import type {NavigationDownload,PageReadinessValue} from "../../../../shared/protocol.js";
import {overlayHostSelector} from "../../shared/overlay.js";
import {withTimeout} from "../timeout.js";

export interface PageReadiness {
  readiness:PageReadinessValue;
  documentId?:string;
  waitMs:number;
  download?:NavigationDownload;
}

/** 读当前文档；读不到时带上 Chrome 给的原因（错误页、不允许注入的地址）。 */
async function probeDocument(tabId:number):Promise<{doc:{documentId:string;url:string;readyState:DocumentReadyState}|null;error?:string}> {
  try {
    const [frame]=await chrome.scripting.executeScript({target:{tabId},injectImmediately:true,world:'ISOLATED',func:()=>({url:location.href,readyState:document.readyState})});

    return {doc:frame?.documentId&&frame.result?{documentId:frame.documentId,...frame.result}:null};
  } catch (error) { return {doc:null,error:error instanceof Error?error.message:String(error)}; }
}

export async function readCurrentDocument(tabId:number) {
  return (await probeDocument(tabId)).doc;
}

/** 扩展按设计就不能注入脚本的地址：浏览器自己的页、别的扩展、Chrome 应用商店。只有这些地址读不到文档时才算加载完。 */
function unscriptableByDesign(url:string|undefined):boolean {
  if(!url)return false;

  try{
    const parsed=new URL(url);

    if(['chrome:','chrome-extension:','chrome-untrusted:','chrome-search:','devtools:','view-source:','about:','edge:'].includes(parsed.protocol))return true;

    return parsed.hostname==='chromewebstore.google.com'||(parsed.hostname==='chrome.google.com'&&parsed.pathname.startsWith('/webstore'));
  }catch{return false;}
}

/** 给模型看的一句话：Chrome 显示了它自己的错误页，页面没打开。navigate 和新开标签页共用。 */
export const ERROR_PAGE_NOTE="Chrome shows its own error page for this address (for example the site could not be reached); the page did not open.";

/** Chrome 拒绝往它自己的错误页注入时给的原因（连不上网站、DNS 失败等）。 */
const ERROR_PAGE=/showing error page/i;

/** 下载出现后最多再等多久 Chrome 报完成（同点击后的下载等待）。 */
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
    // SAFETY: chrome.downloads.State 只有这三个值。
    state:item.state as NavigationDownload['state'],
    bytes:item.state==='complete'?(item.fileSize>=0?item.fileSize:item.bytesReceived):undefined,
    error:item.error,
    danger:item.danger&&item.danger!=='safe'&&item.danger!=='accepted'?item.danger:undefined,
  };
}

/** 给模型看的一句话：地址变成了下载，标签页没换页；存好与否只照 Chrome 的报告说。 */
export function downloadNote(d:NavigationDownload,tab:'stays'|'closed'='stays'):string {
  const where=tab==='closed'?'Chrome closed the new tab it had opened for it':'the tab stays on its current page';
  const head=`This address started a download instead of opening a page; ${where}. Download "${d.filename}"`;

  if(d.state==='complete')return `${head}: Chrome's downloads API reports it complete, saved to ${d.path}${d.bytes!==undefined?` (${d.bytes} B)`:''}.`;

  if(d.state==='interrupted')return `${head}: Chrome reports it failed (${d.error??'interrupted'}); no complete file was saved.`;

  if(d.danger)return `${head}: Chrome flagged it as ${d.danger} and holds it until the user chooses Keep in Chrome's downloads. Not saved yet.`;

  return `${head}: Chrome has not reported it finished yet, so it is not saved yet.`;
}

/**
 * DOM readiness, not completion of images/ads. Confirm the current document twice.
 * 注入脚本问不到的情况由浏览器通知补上（docs/evals/20261010-navigate-wait.md）：地址变成下载时标签页一直是旧文档，
 * chrome:// 页不能注入，原来都要等到超时。dispatch 在监听装好之后才发出跳转，免得几毫秒内的通知漏掉。
 */
export async function waitForInteractive(tabId:number,timeoutMs:number,options:{previousDocumentId?:string;requestedUrl?:string;dispatch?:()=>Promise<unknown>}={}):Promise<PageReadiness> {
  const {previousDocumentId}=options;
  const started=Date.now();let stopped=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let requested='';

  try{requested=options.requestedUrl?new URL(options.requestedUrl).href:'';}catch{/* 不是绝对地址：不认下载 */}

  let onDownload:((item:chrome.downloads.DownloadItem)=>void)|undefined;
  let onTab:((id:number,info:chrome.tabs.OnUpdatedInfo,tab:chrome.tabs.Tab)=>void)|undefined;
  /** 已认出的下载：调用方的超时先到时，结果仍带上这次下载。 */
  let downloadId:number|undefined;

  // 地址变成下载：下载的起始或最终地址就是这次要打开的地址。
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
    // 监听装好之前已经开始的下载：只在打开新标签页时补查，因为那时没法先装监听。先装监听再跳转时补查只会认错旧下载。
    if(!options.dispatch)void Promise.resolve(chrome.downloads.search({startedAfter:new Date(started-1000).toISOString()})).then(items=>items.forEach(take),()=>{});
  });

  // 标签页先报 loading 再报 complete 之后读一次文档：读到新文档就算加载完；Chrome 说是错误页就如实报；
  // 按设计不能注入的地址（chrome:// 等）读不到也算加载完。其余读不到的情况（如本该能注入的网页）交给轮询，宁可超时也不报加载完。
  const loaded=new Promise<PageReadiness>(resolve=>{
    let loading=false;
    onTab=(id,info,tab)=>{
      if(id!==tabId||stopped)return;

      if(info.status==='loading'){loading=true;return;}

      // 新标签页先加载一次空白页，那不是要打开的地址。
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
    // 下载已经开始、还没等到 Chrome 报结果：带上此刻的下载状态，不丢掉。
    void settleDownload(downloadId,0).then(d=>resolve({readiness:'download',download:d,waitMs:Date.now()-started}));
  },timeoutMs);});

  const poll=async():Promise<PageReadiness>=>{
    while(!stopped){
      const probe=await probeDocument(tabId);
      const first=probe.doc;

      if(stopped)break;

      // 读不到是因为 Chrome 显示了错误页：只在标签页已停在要打开的地址、没有待提交的跳转时认。
      // 新开标签页时「开始加载」通知常早于监听装好，上面的 loaded 收不到，不在这里认就只能等到超时。
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

/** 这么久没有 DOM 变化就算页面画完了。 */
const DOM_QUIET_MS=400;

/** 等页面画完最多多等这么久；一直在动的页面（轮播、时钟）到时照常返回。 */
const DOM_QUIET_BOUND_MS=3000;

/** 这几种就绪结果说明眼前是新打开的网页，值得等它画完；下载、错误页、标签页被关掉都不等。 */
export function settlesContent(readiness:PageReadinessValue|undefined):boolean {
  return readiness==='interactive'||readiness==='complete'||readiness==='timeout';
}

/**
 * 客户端渲染的页面在文档可交互后还在往里画内容（TodoMVC 读到时只有页脚）：等 body 里安静一会儿再返回，
 * 打开后附带的快照才读得到内容。安静从 DOMContentLoaded 结束时开始算（延迟脚本和模块脚本已经跑完），不等 load：
 * 图片、字体、广告和统计请求不管多久都不算，有的网站 load 要好几秒，内容早就画好了。
 * 只看 body 里增删节点和文字，不看属性和 head，免得动画、样式注入让它一直等满。
 * body 还是空壳（没有可见文字，也没有链接、按钮、输入框）时，内容还没画出来，继续等第一次画，直到上限。
 * 注入不了（受限页面）或文档在等的时候换掉了，就不等。返回实际多等的毫秒数。
 * 注入的脚本返回一个还没完成的 Promise 时，Chrome 会把页面的 load 事件压到它完成之后，
 * 所以页面里只装一个立刻返回的观察器，再从外面短读它记下的状态；无论怎么结束都拆掉它。
 */
export async function waitForQuietDom(tabId:number):Promise<number> {
  const started=Date.now();
  const left=()=>DOM_QUIET_BOUND_MS-(Date.now()-started);
  // 页面卡在弹窗或长脚本里时注入不会返回，每次短读也要有上限。
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
  }catch{/* 不等也照常返回 */}
  finally{
    // 不等它返回：页面卡住时不多耽误；拆不掉也有页面里自己的上限兜着。
    if(target)void chrome.scripting.executeScript({target,injectImmediately:true,world:'ISOLATED',func:stopWatchInPage}).catch(()=>{});
  }

  return Date.now()-started;
}

/** 页面里观察器记下的状态。隔离环境里只有本扩展的脚本，几次注入之间靠这个全局变量传递。 */
interface QuietDomState {last:number;stop:()=>void}

declare global {
  var __sideagentQuietDom:QuietDomState|undefined;
}

/** 在页面里执行，保持自包含，必须立刻返回。记下 body 里最后一次增删节点或改文字的时间；助手自己挂上的节点不算。到上限自己拆掉。 */
function watchBodyInPage(boundMs:number,ownSelector:string):void {
  globalThis.__sideagentQuietDom?.stop();
  const own=(node:Node)=>node instanceof Element&&!!node.closest(ownSelector);
  const inBody=(node:Node)=>!!document.body?.contains(node);
  const state:QuietDomState={last:performance.now(),stop:()=>{}};

  const mutations=new MutationObserver(records=>{
    if(records.some(r=>inBody(r.target)&&!own(r.target)&&!(r.type==='childList'&&[...r.addedNodes,...r.removedNodes].every(own))))state.last=performance.now();
  });

  // 观察整个文档而不只是当时的 body：页面可能整个换掉 body。
  mutations.observe(document,{subtree:true,childList:true,characterData:true});
  const bound=setTimeout(()=>state.stop(),boundMs+1000);

  state.stop=()=>{
    mutations.disconnect();
    clearTimeout(bound);

    if(globalThis.__sideagentQuietDom===state)delete globalThis.__sideagentQuietDom;
  };
  globalThis.__sideagentQuietDom=state;
}

/**
 * 在页面里执行，保持自包含：DOMContentLoaded 结束后 body 安静了多久，以及 body 是不是还没画出内容的空壳。
 * 空壳：没有可见文字，也没有链接、按钮、输入框、图像或嵌入内容。不设字数门槛：中文页面几个字就是内容。
 * 没有 body 的文档（SVG 等）不会再长出 body，不算空壳。
 */
function readQuietInPage():{quietMs:number;empty:boolean}|null {
  const state=globalThis.__sideagentQuietDom;

  if(!state)return null;
  const navigation=performance.getEntriesByType('navigation')[0];
  // 没有导航计时的文档（极少见）就从观察器装好时算。
  const contentLoaded=navigation instanceof PerformanceNavigationTiming?navigation.domContentLoadedEventEnd:state.last;
  const body=document.body;
  const empty=!!body&&!body.innerText.trim()&&!body.querySelector('a[href],button,input,select,textarea,img,svg,canvas,video,embed,object,iframe,frame');

  return {quietMs:contentLoaded>0?performance.now()-Math.max(state.last,contentLoaded):0,empty};
}

/** 在页面里执行，保持自包含：拆掉观察器、删掉状态。 */
function stopWatchInPage():void {
  globalThis.__sideagentQuietDom?.stop();
}
