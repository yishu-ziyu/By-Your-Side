export interface PageReadiness {
  readiness:'interactive'|'complete'|'timeout';
  documentId?:string;
  waitMs:number;
}
export async function readCurrentDocument(tabId:number) {
  try {
    const [frame]=await chrome.scripting.executeScript({target:{tabId},injectImmediately:true,world:'ISOLATED',func:()=>({url:location.href,readyState:document.readyState})});
    return frame?.documentId&&frame.result?{documentId:frame.documentId,...frame.result}:null;
  } catch { return null; }
}
/** DOM readiness, not completion of images/ads. Confirm the current document twice. */
export async function waitForInteractive(tabId:number,timeoutMs:number,previousDocumentId?:string):Promise<PageReadiness> {
  const started=Date.now();let stopped=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<PageReadiness>(resolve=>{timer=setTimeout(()=>{stopped=true;resolve({readiness:'timeout',waitMs:Date.now()-started});},timeoutMs);});
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
  try{return await Promise.race([poll(),timeout]);}
  finally{stopped=true;if(timer)clearTimeout(timer);}
}
