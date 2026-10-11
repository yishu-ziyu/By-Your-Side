const fs=require('fs');const d=JSON.parse(fs.readFileSync('strings.json'));
for(const o of d){const f=o.file,t=o.text,c=o.ctx;let k='ui';
 if(/call:console\.|call:log\b|call:warn\b|debugLog|trace\(/.test(c)||/^\[sideagent\]|^\[/.test(t))k='dev';
 else if(/function\s*\(|=>|\bconst\b|\breturn\b.*;/.test(t)&&t.length>120)k='code';
 else if(/snapshot|\bref\b|@\$\{|_[a-z]+\(|\b[a-z]+_[a-z_]+\b|参数|\btool\b|调用|notExecuted|Unknown/.test(t)||/notExecuted|describe|description|prompt|Prompt|instruction/i.test(c))k='model';
 else if(/background\/exec\//.test(f))k='model?';
 o.kind=k;}
fs.writeFileSync('strings.json',JSON.stringify(d));
const cnt={};for(const o of d)cnt[o.kind]=(cnt[o.kind]||0)+1;console.log(cnt);
for(const k of ['ui','model?','model']) fs.writeFileSync(`s_${k.replace('?','q')}.txt`,d.filter(o=>o.kind===k).map(o=>`${o.file.replace('extension/src/','')}:${o.line}\t${o.text.slice(0,200)}\t[${o.ctx.slice(0,70)}]`).join('\n'));
