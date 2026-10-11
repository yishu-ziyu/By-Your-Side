import {requestMicrophonePermission} from './voice-permission.js';

const enable=document.querySelector<HTMLButtonElement>('#enable')!;

const status=document.querySelector<HTMLElement>('#status')!;

const help=document.querySelector<HTMLElement>('#help')!;

enable.onclick=async()=>{
  enable.disabled=true;help.hidden=true;status.textContent='在 Chrome 的询问里，选「允许」。';

  try {
    await requestMicrophonePermission();
    status.textContent='麦克风已授权。回到 By Your Side 侧栏，再试一次。';
    enable.textContent='授权完成';
    document.querySelector<HTMLElement>('#done')!.hidden=false;
  } catch(error) {
    status.textContent=error instanceof DOMException && error.name==='NotFoundError'?'没有找到麦克风。连接麦克风后再试一次。':'Chrome 没有允许使用麦克风。检查下面的设置，再试一次。';
    help.hidden=false;enable.disabled=false;enable.textContent='重新请求授权';
  }
};

// 系统设置的路径按系统写：只有 macOS 和 Windows 有固定的路径。
const ua=navigator.userAgent;
document.querySelector<HTMLElement>('#os-help')!.textContent=/Mac/i.test(ua)?'打开 macOS「系统设置 → 隐私与安全性 → 麦克风」，检查 Chrome 的权限':/Windows/i.test(ua)?'打开 Windows「设置 → 隐私和安全性 → 麦克风」，检查 Chrome 的权限':'在系统的声音设置里，检查输入设备和 Chrome 的权限';

document.querySelector<HTMLButtonElement>('#settings')!.onclick=()=>void chrome.tabs.create({url:'chrome://settings/content/microphone'});

document.querySelector<HTMLButtonElement>('#done')!.onclick=()=>window.close();
