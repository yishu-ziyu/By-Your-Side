import {afterEach,expect,it,vi} from 'vitest';
import {VoiceObservation} from '../src/background/voice-observation.js';
afterEach(()=>vi.unstubAllGlobals());
function harness(){
 const page={text:'visible',url:'https://same.test',title:'same',timeOrigin:1,width:800,height:600,x:0,y:0};
 const chrome={tabs:{query:vi.fn(async()=>[{id:7,windowId:2,url:page.url}]),captureVisibleTab:vi.fn(async()=> 'data:image/png;base64,AQID'),update:vi.fn()},scripting:{executeScript:vi.fn(async()=>[{frameId:0,documentId:'doc1',result:page}])}};
 vi.stubGlobal('chrome',chrome);return {chrome,page,observer:new VoiceObservation()};
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
it('rejects forged, expired and cleared grants before reading any page',async()=>{
 const h=harness(),grant=await h.observer.issue();
 await expect(h.observer.capture('forged',()=>true)).rejects.toThrow();
 const time=vi.spyOn(Date,'now').mockReturnValue(Date.now()+61000);
 await expect(h.observer.capture(grant!.token,()=>true)).rejects.toThrow();time.mockRestore();h.observer.clear();
 await expect(h.observer.capture(grant!.token,()=>true)).rejects.toThrow();expect(h.chrome.scripting.executeScript).not.toHaveBeenCalled();
});
