import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
export function voiceEvidence(){
 const files=execFileSync('rg',['--files','agent/src','extension/src','shared'],{encoding:'utf8'}).trim().split('\n').sort();
 const hash=createHash('sha256');for(const file of files)hash.update(file+'\0').update(readFileSync(file));
 const sha=(file:string)=>{try{return createHash('sha256').update(readFileSync(file)).digest('hex');}catch{return null;}};
 return {sourceSha256:hash.digest('hex'),head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scriptSha256:process.argv[1]?sha(process.argv[1]):null,backgroundSha256:sha('extension/dist/background.js'),sidepanelSha256:sha('extension/dist/sidepanel.js'),lockSha256:sha('package-lock.json')};
}
