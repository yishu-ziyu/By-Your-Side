/** Read-only grants are issued by a live voice lease, never by page content or task tools. */
export class VoiceObservation {
  private grants=new Map<string,{tabId:number;expires:number}>();
  clear():void {this.grants.clear();}
  async issue():Promise<{token:string;tabId:number}|undefined>{
    const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
    if(tab?.id===undefined||!/^https?:/.test(tab.url??''))return;
    const token=crypto.randomUUID();this.grants.set(token,{tabId:tab.id,expires:Date.now()+60000});
    while(this.grants.size>2)this.grants.delete(this.grants.keys().next().value!);
    return {token,tabId:tab.id};
  }
  async capture(token:unknown,valid:()=>boolean):Promise<unknown>{
    const grant=typeof token==='string'?this.grants.get(token):undefined;
    const check=async()=>{
      if(!grant||grant.expires<Date.now()||!valid())throw new Error('页面观察授权已失效。');
      const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
      if(tab?.id!==grant.tabId)throw new Error('当前页面已切换，请重新询问。');
      return tab;
    };
    const tab=await check();
    const read=async()=>{
      const results=await chrome.scripting.executeScript({target:{tabId:grant!.tabId},world:'ISOLATED',func:()=>{
        const pieces:string[]=[];let size=0,count=0;
        const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
        while(walker.nextNode()&&count++<1500&&size<12000){
          const node=walker.currentNode,parent=node.parentElement,text=node.textContent?.trim();
          if(!parent||!text||parent.closest('script,style,noscript,[aria-hidden="true"]'))continue;
          const style=getComputedStyle(parent);if(style.visibility==='hidden'||style.display==='none'||style.opacity==='0')continue;
          const range=document.createRange();range.selectNodeContents(node);
          if(!Array.from(range.getClientRects()).some(r=>r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth))continue;
          pieces.push(text);size+=text.length;
        }
        return {text:pieces.join('\n').slice(0,12000),url:location.href,title:document.title,timeOrigin:performance.timeOrigin,width:innerWidth,height:innerHeight,x:scrollX,y:scrollY};
      }});
      const main=results.find(r=>r.frameId===0);
      if(!main?.documentId||!main.result)throw new Error('未取得页面文档身份。');
      return {documentId:main.documentId,...main.result};
    };
    const before=await read();await check();
    const dataUrl=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'png'});
    await check();const after=await read();await check();
    if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('页面在读取期间变化，本次文字和截图已丢弃。');
    if(!dataUrl.startsWith('data:image/png;base64,'))throw new Error('截图格式无效。');
    return {...after,tabId:grant!.tabId,capturedAt:Date.now(),scope:'viewport',imageBase64:dataUrl.slice('data:image/png;base64,'.length)};
  }
}
