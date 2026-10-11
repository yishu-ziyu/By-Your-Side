const fs=require('fs');const d=JSON.parse(fs.readFileSync('strings.json'));
const banned=[
 ['Agent','助手','R1'],['agent','助手','R1'],['worker','助手','R1/R9'],['控制权','页面控制','R1'],['移交','交还/接手','R1'],
 ['插件','扩展','R1'],['对话','会话','R1'],['聊天','会话','R1'],['当前模型','主模型','R1'],['凭据','密钥','R1'],['令牌','登录状态','R1'],
 ['诊断日志','诊断记录','R1'],['AI 助手','助手','R1'],['问 AI','问助手','R1'],['要 AI','要助手','R1'],
 ['provider','服务商','R1'],['伴随进程','—','R9'],['检查点','—','R9'],['基线','—','R9'],['控制轮次','—','R9'],['工件','文件','R9'],
 ['执行脚本','—','R9'],['调用','—','R9'],['元素','—','R9'],['视口','—','R9'],['上游','—','R9'],['服务端','—','R9'],['后端','—','R9'],
 ['转写','—','R9'],['采样率','—','R9'],['上行','—','R9'],['本地池','—','R9'],['名册','—','R9'],['请了人','—','R9'],
 ['核实','核对/核验','R1'],['校验','核验','R1'],['网页','页面','R1'],['这页','这个页面','R1'],['忘掉','忘记','R1'],
 ['停下','中止','R1'],['终止','中止','R1'],['结果待确认','结果未知','R1'],['Key','密钥','R1'],['key','密钥','R1'],['API key','密钥','R1'],
];
const hits=[];
function units(s){s=s.replace(/\$\{[^}]*\}/g,'X');return (s.match(/[\u4e00-\u9fff]|[A-Za-z0-9_.\-+⌘⇧⌥]+/g)||[]).length;}
for(const o of d){ if(o.kind!=='ui')continue; const t=o.text; const r=[];
 for(const [w,rep,rule] of banned){ if(w==='对话'&&/语音对话/.test(t)&&!t.replace(/语音对话/g,'').includes('对话'))continue; if(w==='网页'&&/网页截图/.test(t)){} if(t.includes(w)) r.push(`${rule} 用词「${w}」`);}
 if(/[；;]/.test(t.replace(/&[a-z]+;/g,''))&&!/\{|\}/.test(t.replace(/\$\{[^}]*\}/g,''))) r.push('R11 分号');
 for(const s of t.split(/[。！？!?\n]/)){const n=units(s); if(n>25){r.push(`R2/R3 句长 ${n}`);break;}}
 if(/^请|，请|。请/.test(t)) r.push('MS/GOV 请');
 if(/被/.test(t)) r.push('R7 被动');
 if(/^(无法|未能|不能)/.test(t)) r.push('R7 无主语否定');
 if(r.length) hits.push({...o,rules:r});
}
fs.writeFileSync('autoscan.json',JSON.stringify(hits));
const c={};for(const h of hits)for(const r of h.rules){const k=r.split(' ')[0]+' '+(r.split(' ')[1]||'').replace(/\d+/,'');c[k]=(c[k]||0)+1;}
console.log(hits.length, d.filter(o=>o.kind==='ui').length); console.log(Object.entries(c).sort((a,b)=>b[1]-a[1]).slice(0,60));
const uniq=new Set(d.filter(o=>o.kind==='ui').map(o=>o.text));console.log('unique ui',uniq.size);
