/**
 * 站点提示：某些网站用通用的点击、截图做不成事（例如画布白板），这里给模型一段该站点的做法。
 * 只在这一轮开始时的页面属于表里的站点时注入；其他网站不注入。依据见 docs/evals/20261010-site-hints-excalidraw.md。
 */

const SITE_HINTS: Array<{host: string; hint: string}> = [
  {
    host: "excalidraw.com",
    hint: `Excalidraw whiteboard. Clicking drawing tools, screenshots, the Open/import menu and saving files fail here. Do each request in ONE js call (async()=>{...})(): API, then the change, then the check.
API: const el=document.querySelector(".excalidraw");let f=el[Object.keys(el).find(k=>k.startsWith("__reactFiber"))];while(f&&!f.stateNode?.api?.updateScene)f=f.return;const api=f.stateNode.api;
Create: put the whole diagram in one array els, paste it once. Per step (x += 220):
{id:"b1",type:"rectangle",x:0,y:0,width:160,height:70,boundElements:[{type:"text",id:"t1"},{type:"arrow",id:"a1"}]},{id:"t1",type:"text",text:"Step 1",fontSize:20,containerId:"b1",textAlign:"center",verticalAlign:"middle"},{id:"a1",type:"arrow",x:160,y:35,points:[[0,0],[60,0]],startBinding:{elementId:"b1"},endBinding:{elementId:"b2"},endArrowhead:"arrow"}
Text needs fontSize; a box lists its text and all its arrows in boundElements. Paste is async; wait, then fit to view (Shift+1):
const dt=new DataTransfer();dt.setData("text/plain",JSON.stringify({type:"excalidraw/clipboard",elements:els,files:{}}));document.dispatchEvent(new ClipboardEvent("paste",{clipboardData:dt,bubbles:true}));await new Promise(r=>setTimeout(r,500));document.dispatchEvent(new KeyboardEvent("keydown",{key:"!",code:"Digit1",shiftKey:true,bubbles:true}));
Edit: paste renames ids, so find a step by its text; its box id is the text's containerId. Write changed copies back:
api.updateScene({elements:api.getSceneElements().map(e=>e.id===boxId?{...e,strokeColor:"#e03131",backgroundColor:"#ffc9c9",version:e.version+1,versionNonce:Math.random()*2**31|0,updated:Date.now()}:e),captureUpdate:"IMMEDIATELY"});
Check (tool results hide ids, so it names boxes by label; return it as is):
const all=api.getSceneElements(),label=id=>all.find(t=>t.containerId===id)?.text;return all.filter(e=>!e.containerId).map(e=>({type:e.type,label:e.text??label(e.id),from:label(e.startBinding?.elementId),to:label(e.endBinding?.elementId),head:e.endArrowhead,stroke:e.strokeColor,bg:e.backgroundColor}));`,
  },
];

/** 页面地址对应的站点提示；子域名（www.）也算；没有就返回 null。 */
export function siteHintFor(url: string | null | undefined): {host: string; text: string} | null {
  let hostname: string;

  try { hostname = new URL(url ?? "").hostname; } catch { return null; }
  const entry = SITE_HINTS.find(site => hostname === site.host || hostname.endsWith(`.${site.host}`));

  return entry ? {host: entry.host, text: `# Site hint (${entry.host})\n${entry.hint}`} : null;
}
