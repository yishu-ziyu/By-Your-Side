import {afterEach,expect,it,vi} from 'vitest';
import {VoiceObservation} from '../src/background/voice-observation.js';

afterEach(()=>vi.unstubAllGlobals());

function harness(){
 const page={text:'visible',url:'https://same.test',title:'same',timeOrigin:1,width:800,height:600,x:0,y:0};
 const chrome={tabs:{query:vi.fn(async()=>[{id:7,windowId:2,url:page.url}]),captureVisibleTab:vi.fn(async()=> 'data:image/png;base64,AQID'),update:vi.fn()},scripting:{executeScript:vi.fn(async()=>[{frameId:0,documentId:'doc1',result:page}])}};
 vi.stubGlobal('chrome',chrome);

return {chrome,page,observer:new VoiceObservation()};
}

it('captures one current viewport without switching tabs or using task references',async()=>{
 const h=harness(),grant=await h.observer.issue();
 expect(await h.observer.capture(grant!.token,()=>true)).toMatchObject({tabId:7,scope:'viewport',documentId:'doc1',imageBase64:'AQID',text:'visible'});
 expect(h.chrome.tabs.update).not.toHaveBeenCalled();expect(h.chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(2,{format:'png'});
});

it.each(['document','tab','lease'])('rejects a %s change during capture',async(mode)=>{
 const h=harness(),grant=await h.observer.issue();let valid=true;
 h.chrome.tabs.captureVisibleTab.mockImplementation(async()=>{
  if(mode==='document')h.chrome.scripting.executeScript.mockResolvedValue([{frameId:0,documentId:'doc2',result:h.page}]);

  if(mode==='tab')h.chrome.tabs.query.mockResolvedValue([{id:8,windowId:2,url:h.page.url}]);

  if(mode==='lease')valid=false;

  return 'data:image/png;base64,AQID';
 });
 await expect(h.observer.capture(grant!.token,()=>valid)).rejects.toThrow();
});

it('reads changing same-document text without taking or depending on a screenshot',async()=>{
 const h=harness(),grant=await h.observer.issue();let reads=0;
 h.chrome.scripting.executeScript.mockImplementation(async()=>[{frameId:0,documentId:'doc1',result:{...h.page,text:`updated ${++reads}`,width:800-reads,y:reads}}]);
 h.chrome.tabs.captureVisibleTab.mockRejectedValue(new Error('screenshot unavailable'));
 const result=await h.observer.capture(grant!.token,()=>true,'text');
 expect(result).toMatchObject({text:'updated 2',documentId:'doc1',scope:'viewport'});
 expect(result).not.toHaveProperty('imageBase64');expect(h.chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
});

it('retries temporarily empty text on the same document, bounded at three reads',async()=>{
 const h=harness(),grant=await h.observer.issue();let reads=0;
 h.chrome.scripting.executeScript.mockImplementation(async()=>[{frameId:0,documentId:'doc1',result:{...h.page,text:++reads<3?'':'Loaded repository README'}}]);
 expect(await h.observer.capture(grant!.token,()=>true,'text')).toMatchObject({text:'Loaded repository README'});
 expect(reads).toBe(3);expect(h.chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
});

it('reports empty text after bounded rereads, never as a successful page read',async()=>{
 const h=harness(),grant=await h.observer.issue();h.page.text='';
 await expect(h.observer.capture(grant!.token,()=>true,'text')).rejects.toThrow('没有可读文字');
 expect(h.chrome.scripting.executeScript).toHaveBeenCalledTimes(3);
});

it.each(['document','url','tab','lease'])('text reads reject a %s change without retrying onto another page',async(mode)=>{
 const h=harness(),grant=await h.observer.issue();let valid=true,reads=0;
 h.chrome.scripting.executeScript.mockImplementation(async()=>{
  reads++;

  if(reads===2){
   if(mode==='tab')h.chrome.tabs.query.mockResolvedValue([{id:8,windowId:2,url:h.page.url}]);

   if(mode==='lease')valid=false;
  }

  return [{frameId:0,documentId:mode==='document'&&reads===2?'doc2':'doc1',result:{...h.page,url:mode==='url'&&reads===2?'https://other.test':h.page.url}}];
 });
 await expect(h.observer.capture(grant!.token,()=>valid,'text')).rejects.toThrow();
 expect(reads).toBe(2);expect(h.chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
});

it('rejects forged, expired and cleared grants before reading any page',async()=>{
 const h=harness(),grant=await h.observer.issue();
 await expect(h.observer.capture('forged',()=>true)).rejects.toThrow();
 const time=vi.spyOn(Date,'now').mockReturnValue(Date.now()+61000);
 await expect(h.observer.capture(grant!.token,()=>true)).rejects.toThrow();time.mockRestore();h.observer.clear();
 await expect(h.observer.capture(grant!.token,()=>true)).rejects.toThrow();expect(h.chrome.scripting.executeScript).not.toHaveBeenCalled();
});
