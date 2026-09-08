import {requestMicrophonePermission} from './voice-permission.js';
const enable=document.querySelector<HTMLButtonElement>('#enable')!;
const status=document.querySelector<HTMLElement>('#status')!;
const help=document.querySelector<HTMLElement>('#help')!;
enable.onclick=async()=>{
  enable.disabled=true;help.hidden=true;status.textContent='请在 Chrome 的询问中选择允许。';
  try {
    await requestMicrophonePermission();
    status.textContent='麦克风已授权。回到 By Your Side 侧栏，点击重试即可。';
    enable.textContent='授权完成';
    document.querySelector<HTMLElement>('#done')!.hidden=false;
  } catch(error) {
    status.textContent=error instanceof DOMException && error.name==='NotFoundError'?'没有找到麦克风，请连接设备后重试。':'没有获得麦克风权限。请检查下方设置后重试。';
    help.hidden=false;enable.disabled=false;enable.textContent='重新请求授权';
  }
};
document.querySelector<HTMLButtonElement>('#settings')!.onclick=()=>void chrome.tabs.create({url:'chrome://settings/content/microphone'});
document.querySelector<HTMLButtonElement>('#done')!.onclick=()=>window.close();
