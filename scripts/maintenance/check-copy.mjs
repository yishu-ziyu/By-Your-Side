import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const BANNED = [
  [/Agent/, '助手'], [/问 ?AI|要 ?AI|AI ?助手/, '助手'], [/成员/, '助手 / 页面'],
  [/停下|收手|停手|停住|终止/, '中止 / 暂停'], [/已停止(?!回答)/, '已中止'], [/停下/, '中止'], [/结果待确认/, '结果未知'],
  [/检查点|伴随进程|基线|复活|控制权|移交|名册|请了人|工件|本地池/, '白话'],
  [/令牌|凭据/, '密钥 / 登录'], [/诊断日志/, '诊断记录'], [/忘掉/, '忘记'], [/截屏/, '截图'],
  [/(?<![A-Za-z_.])(API )?[Kk]ey(?![A-Za-z_])/, '密钥'],
];

const MODEL_FACING = /^extension\/src\/(background\/exec\/|content\/domops|inproc\/shims|background\/marginalia|background\/nudge)/;

const MODEL_TEXT = /操作未执行|worker|父 Agent|snapshot|^\s*用户/;

const CJK = /[一-鿿]/;

async function files(dir) {
  const out = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) { if (entry.name !== 'vendor') out.push(...await files(full)); }
    else if (/\.(ts|mts)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) out.push(full);
  }

  return out;
}

function literals(src) {
  const out = [];
  let i = 0;
  let line = 1;

  const take = (quote) => {
    const startLine = line;
    let text = '';
    i += 1;

    while (i < src.length && src[i] !== quote) {
      if (src[i] === '\\') { text += src[i + 1] ?? ''; i += 2; continue; }

      if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
        out.push([startLine, text]);
        text = ' ';
        let depth = 1;
        i += 2;

        while (i < src.length && depth) {
          if (src[i] === '{') depth += 1;
          else if (src[i] === '}') depth -= 1;
          else if (src[i] === '\n') line += 1;
          else if (src[i] === '"' || src[i] === "'" || src[i] === '`') { take(src[i]); continue; }
          i += 1;
        }
        continue;
      }

      if (src[i] === '\n') line += 1;
      text += src[i];
      i += 1;
    }
    i += 1;
    out.push([startLine, text]);
  };

  while (i < src.length) {
    const c = src[i];

    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; }
    else if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line += 1; i += 1; }
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') take(c);
    else if (c === '/' && /[(,=:[!&|?{};]\s*$|^\s*$/.test(src.slice(Math.max(0, i - 40), i).split('\n').at(-1))) {
      let inClass = false;
      i += 1;

      while (i < src.length && src[i] !== '\n' && (inClass || src[i] !== '/')) {
        if (src[i] === '\\') i += 1;
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        i += 1;
      }
      i += 1;
    } else { if (c === '\n') line += 1; i += 1; }
  }

  return out;
}

const hits = [];

function check(file, line, text, sourceLine) {
  if (!CJK.test(text) || MODEL_TEXT.test(text) || /copy-ok/.test(sourceLine)) return;

  for (const [word, use] of BANNED) {
    const m = text.match(word);

    if (m) hits.push(`${file}:${line}  「${m[0]}」→ ${use}  ${text.replace(/\s+/g, ' ').trim().slice(0, 60)}`);
  }
}

for (const full of await files(path.join(repo, 'extension/src'))) {
  const file = path.relative(repo, full);

  if (MODEL_FACING.test(file)) continue;
  const src = await readFile(full, 'utf8');
  const lines = src.split('\n');

  for (const [startLine, raw] of literals(src)) {
    raw.split('\n').forEach((part, i) => {
      const sourceLine = lines[startLine + i - 1] ?? '';

      if (!/console\./.test(sourceLine)) check(file, startLine + i, part.replace(/\/\*.*?\*\/|<[^>]*>/g, ' '), sourceLine);
    });
  }
}

for (const name of await readdir(path.join(repo, 'extension'))) {
  if (!name.endsWith('.html')) continue;
  const lines = (await readFile(path.join(repo, 'extension', name), 'utf8')).split('\n');
  lines.forEach((line, i) => check(`extension/${name}`, i + 1, line.replace(/<(script|style)[\s\S]*?<\/\1>|<[^>]*>/g, ' '), line));
}

if (hits.length) {
  console.error(`界面用词：${hits.length} 处用了术语表「不再用」的词。确实要用时在那一行写 copy-ok 注释。\n${hits.join('\n')}`);
  process.exit(1);
}

console.log('界面用词：通过');
