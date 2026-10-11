const fs=require('fs');const d=JSON.parse(fs.readFileSync('strings.json'));
const modelFiles=/(content\/domops|shared\/target|shared\/editable-text|browser-observation|observed-node-rect|isolated-read-context|axstate|axtree|worker-tab-control|tab-bindings|inproc\/shims|background\/exec\/|observation-document|route-target|cursor-context|page-events|background\/marginalia|background\/nudge|inproc\/ptt-dictation\.ts:106)/;
for(const o of d){ if(o.kind!=='ui')continue;
 if(/^[A-Z_]{4,}:/.test(o.text)||modelFiles.test(o.file)||/操作未执行|未执行。|父 Agent|worker|请重新 snapshot/.test(o.text)||/^function|<style>|\.cursor \{|\/\*/.test(o.text)) o.kind='model';
 // prompts sent as user message (starter/skills templates) are user-authored-on-behalf: keep but tag
}
const cnt={};for(const o of d)cnt[o.kind]=(cnt[o.kind]||0)+1;console.log(cnt);
const ui=d.filter(o=>o.kind==='ui');console.log('unique ui',new Set(ui.map(o=>o.text)).size,'files',new Set(ui.map(o=>o.file)).size);
fs.writeFileSync('strings.json',JSON.stringify(d));
