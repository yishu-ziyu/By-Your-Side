import type {NavigationDownload,PageReadinessValue} from "../../../../shared/protocol.js";

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
      const first=await readCurrentDocument(tabId);

      if(stopped)break;

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
