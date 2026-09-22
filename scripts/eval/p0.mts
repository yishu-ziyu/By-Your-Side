import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {emptyP0Report,validateP0Report,type P0Build,type P0Manifest} from './lib/p0-contract.js';

const root=fileURLToPath(new URL('../../',import.meta.url));

const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

const manifestText=readFileSync(join(root,'eval/p0/cases.json'),'utf8');

const manifest=JSON.parse(manifestText) as P0Manifest;

// HEAD alone cannot identify a locally modified extension or native host.
const paths=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard','--','agent/src','extension/src','shared','package.json','package-lock.json','agent/package.json','extension/package.json','extension/build.mjs','extension/manifest.json','extension/public','extension/static','eval/p0','scripts/eval/lib/p0-fixture.ts','scripts/acceptance/p0-fixture.mts','scripts/acceptance/p0-local-agent-run.mts','scripts/acceptance/round-evidence.mts'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);

const fingerprint=createHash('sha256');

for(const path of [...new Set(paths)].sort()){
  fingerprint.update(path).update('\0');

  try{fingerprint.update(readFileSync(join(root,path)));}catch{fingerprint.update('[deleted]');}

  fingerprint.update('\0');
}

const build:P0Build={head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),fingerprint:fingerprint.digest('hex'),manifestHash:sha(manifestText)};

try{
  const [action,path]=process.argv.slice(2);

  if(!path||!['--init','--verify'].includes(action??''))throw new Error('用法：npm run eval:p0 -- --init out/acceptance/p0-local-agent 或 --verify <该目录>/results.json');
  const target=resolve(root,path);

  if(action==='--init'){
    const allowed=join(root,'out','acceptance');

    if(target===allowed||relative(allowed,target).startsWith('..')||isAbsolute(relative(allowed,target)))throw new Error('结果目录必须是 out/acceptance 内的独立子目录。');
    mkdirSync(target,{recursive:true});
    writeFileSync(join(target,'results.json'),JSON.stringify(emptyP0Report(manifest,build),null,2)+'\n',{flag:'wx'});
    console.log(`已生成未运行模板：${relative(root,join(target,'results.json'))}\n实机测试尚未运行。填写后用 --verify 校验；不会启动浏览器或模型。`);
  }else{
    const base=realpathSync(dirname(target));

    const result=validateP0Report(JSON.parse(readFileSync(target,'utf8')),manifest,build,(path,hash)=>{
      try{
        if(isAbsolute(path))return false;
        const actual=realpathSync(resolve(base,path));const rel=relative(base,actual);

        return !!rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&statSync(actual).isFile()&&statSync(actual).size>0&&sha(readFileSync(actual))===hash;
      }catch{return false;}
    });

    console.log(JSON.stringify(result,null,2));
    process.exitCode=result.status==='PASS'?0:result.status==='FAIL'?1:2;
  }
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
