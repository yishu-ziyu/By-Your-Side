const ts=require('typescript'),fs=require('fs'),path=require('path');
const root='/workspace/By-Your-Side/extension/src';
const CJK=/[\u4e00-\u9fff]/;
const out=[];
function walkDir(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);if(fs.statSync(p).isDirectory()){if(f==='vendor')continue;walkDir(p);}else if(/\.(ts|tsx|mts)$/.test(f)&&!/\.(test|spec)\./.test(f))doFile(p);}}
function ctxOf(node,sf){let n=node.parent,steps=0;const bits=[];
  while(n&&steps<6){
    if(ts.isPropertyAssignment(n)&&n.name)bits.push('prop:'+n.name.getText(sf));
    else if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken)bits.push('assign:'+n.left.getText(sf).split('.').slice(-1)[0]);
    else if(ts.isCallExpression(n))bits.push('call:'+n.expression.getText(sf).slice(-40));
    else if(ts.isNewExpression(n))bits.push('new:'+n.expression.getText(sf));
    else if(ts.isThrowStatement(n))bits.push('throw');
    else if(ts.isReturnStatement(n))bits.push('return');
    else if(ts.isVariableDeclaration(n))bits.push('var:'+n.name.getText(sf));
    else if(ts.isFunctionDeclaration(n)&&n.name){bits.push('fn:'+n.name.text);break;}
    n=n.parent;steps++;}
  // enclosing function name
  let f=node.parent;while(f&&!(ts.isFunctionDeclaration(f)||ts.isMethodDeclaration(f)))f=f.parent;
  if(f&&f.name)bits.push('in:'+f.name.getText(sf));
  return bits.join(' ');}
function push(file,line,text,ctx){text=text.replace(/\s+/g,' ').trim();if(!CJK.test(text))return;out.push({file:path.relative('/workspace/By-Your-Side',file),line,text,ctx});}
function doFile(p){const src=fs.readFileSync(p,'utf8');const sf=ts.createSourceFile(p,src,ts.ScriptTarget.Latest,true);
  const visit=n=>{
    if(ts.isImportDeclaration(n)||ts.isExportDeclaration(n))return;
    if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isTemplateExpression(n)){
      let raw=n.getText(sf).slice(1,-1);const start=n.getStart(sf);const baseLine=sf.getLineAndCharacterOfPosition(start).line+1;const ctx=ctxOf(n,sf);
      if(/<[a-z][\s\S]*>/i.test(raw)&&raw.includes('\n')){
        // HTML template: split into text nodes & attr values, per line
        const re=/(?:(title|aria-label|placeholder|alt|data-tip|label)="([^"]*)")|>([^<]+)</g;let m;
        while((m=re.exec(raw))){const t=m[2]??m[3];const ln=baseLine+raw.slice(0,m.index).split('\n').length-1;push(p,ln,t,(m[1]?'attr:'+m[1]+' ':'html ')+ctx);}
      } else push(p,baseLine,raw,ctx);
      if(ts.isTemplateExpression(n))return; // don't descend into spans
    }
    ts.forEachChild(n,visit);};
  visit(sf);}
walkDir(root);
// html files in extension root used by src? include extension/*.html
for(const f of fs.readdirSync('/workspace/By-Your-Side/extension')){if(f.endsWith('.html')){const p='/workspace/By-Your-Side/extension/'+f;const raw=fs.readFileSync(p,'utf8');const re=/(?:(title|aria-label|placeholder|alt)="([^"]*)")|>([^<]+)</g;let m;while((m=re.exec(raw))){const t=m[2]??m[3];push(p,raw.slice(0,m.index).split('\n').length,t,'html-file');}}}
fs.writeFileSync('strings.json',JSON.stringify(out,null,0));
fs.writeFileSync('strings.txt',out.map(o=>`${o.file.replace('extension/src/','')}:${o.line}\t${o.text.slice(0,240)}\t[${o.ctx}]`).join('\n'));
console.log(out.length);
