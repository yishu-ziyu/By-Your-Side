import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// WHY: esbuild is owned by the extension workspace; do not rely on npm hoisting.
const { transform } = createRequire(new URL('../../extension/package.json', import.meta.url))('esbuild');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const codeFile = /\.(?:[cm]?[jt]s|tsx|jsx|css)$/;
const skipped = /(^|\/)vendor\//;

const kept = text => {
  const body = text.replace(/^(?:\/\/+|\/\*+)[\s*]*/, '');
  return /^(?:WHY|SAFETY):/.test(body) || /Copyright|SPDX|@license/.test(text) || /^\/\/\/\s*</.test(text);
};

const regexAfterWord = /(?:^|[^\w$.])(?:return|typeof|instanceof|case|in|of|delete|void|throw|new|else|do|yield|await)$/;

function regexEnd(source, start) {
  let inClass = false;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\n') return -1;
    if (ch === '\\') i++;
    else if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) return i + 1;
  }
  return -1;
}

// WHY: TypeScript 7 ships no JS compiler API, so this is a small lexer; a misread is caught by the compiled-output comparison in main.
function scriptRanges(source) {
  const ranges = [];
  const templateDepths = [];
  let depth = 0;
  let code = '';
  let i = source.startsWith('#!') ? source.indexOf('\n') : 0;
  const template = from => {
    let at = from;
    while (at < source.length) {
      if (source[at] === '\\') at += 2;
      else if (source[at] === '`') return at + 1;
      else if (source[at] === '$' && source[at + 1] === '{') {
        templateDepths.push(depth);
        depth++;
        code = '{';
        return at + 2;
      } else at++;
    }
    return at;
  };
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i);
      const end = newline < 0 ? source.length : newline;
      ranges.push({ pos: i, end: source[end - 1] === '\r' ? end - 1 : end });
      i = end;
    } else if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close < 0 ? source.length : close + 2;
      ranges.push({ pos: i, end });
      i = end;
    } else if (ch === '/') {
      const tail = code.trimEnd();
      const regexAllowed = !tail || /[(,=:[!&|?{};+\-*%<>~^]$/.test(tail) || regexAfterWord.test(tail.slice(-12));
      const end = regexAllowed ? regexEnd(source, i) : -1;
      code = '/';
      if (end > 0) code = '0';
      i = end > 0 ? end : i + 1;
    } else if (ch === '"' || ch === "'") {
      let at = i + 1;
      while (at < source.length && source[at] !== ch && source[at] !== '\n') at += source[at] === '\\' ? 2 : 1;
      code = '0';
      i = at + 1;
    } else if (ch === '`') {
      code = '0';
      i = template(i + 1);
    } else if (ch === '}' && templateDepths.at(-1) === depth - 1) {
      depth--;
      templateDepths.pop();
      code = '0';
      i = template(i + 1);
    } else {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      code = (code + ch).slice(-16);
      i++;
    }
  }
  return ranges;
}

function styleRanges(source) {
  const ranges = [];
  let quote = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      ranges.push({ pos: i, end: stop });
      i = stop - 1;
    }
  }
  return ranges;
}

// WHY: a run of `//` lines is one comment, so a WHY: on its first line keeps the whole explanation.
function groups(source, ranges) {
  const out = [];
  for (const range of ranges) {
    const last = out.at(-1);
    const joined = last
      && source.startsWith('//', range.pos)
      && source.startsWith('//', last.at(-1).pos)
      && !/^\/\/+\s*(?:WHY|SAFETY):/.test(source.slice(range.pos, range.end))
      && /^[ \t]*\r?\n[ \t]*$/.test(source.slice(last.at(-1).end, range.pos));
    if (joined) last.push(range);
    else out.push([range]);
  }
  return out;
}

export function comments(file, source) {
  const ranges = file.endsWith('.css') ? styleRanges(source) : scriptRanges(source);
  return groups(source, ranges).map(group => ({
    pos: group[0].pos,
    end: group.at(-1).end,
    line: source.slice(0, group[0].pos).split('\n').length,
    text: source.slice(group[0].pos, group.at(-1).end),
  }));
}

function strip(source, unwanted) {
  let out = source;
  for (const { pos, end } of [...unwanted].reverse()) {
    const lineStart = out.lastIndexOf('\n', pos - 1) + 1;
    const newline = out.indexOf('\n', end);
    const lineEnd = newline < 0 ? out.length : newline;
    const before = out.slice(lineStart, pos);
    const after = out.slice(end, lineEnd);
    if (!before.trim() && !after.trim()) {
      const next = Math.min(lineEnd + 1, out.length);
      const followingEnd = out.indexOf('\n', next);
      const blankAbove = lineStart === 0 || /(^|\n)[ \t]*\n$/.test(out.slice(0, lineStart));
      const blankBelow = followingEnd >= 0 && !out.slice(next, followingEnd).trim();
      out = out.slice(0, lineStart) + out.slice(blankAbove && blankBelow ? followingEnd + 1 : next);
    } else if (!after.trim()) {
      out = out.slice(0, pos).replace(/[ \t]+$/, '') + out.slice(end);
    } else {
      out = out.slice(0, pos) + out.slice(end).replace(/^[ \t]+/, before.trim() ? ' ' : '');
    }
  }
  return out.replace(/^(?:[ \t]*\r?\n)+/, '');
}

const loaderFor = file => (file.endsWith('.css') ? 'css' : file.endsWith('x') ? 'tsx' : /\.[cm]?ts$/.test(file) ? 'ts' : 'js');

const compiled = async (file, source) => (await transform(source, {
  loader: loaderFor(file),
  minifyWhitespace: true,
  legalComments: 'none',
  sourcefile: file,
})).code;

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(file => codeFile.test(file) && !skipped.test(file));
}

async function main() {
  const mode = process.argv[2];
  if (mode !== '--check' && mode !== '--write') {
    console.error('Usage: comments.mjs --check | --write');
    process.exit(2);
  }
  const failures = [];
  let removed = 0;
  let changed = 0;
  for (const file of trackedFiles()) {
    const source = readFileSync(path.join(root, file), 'utf8');
    const unwanted = comments(file, source).filter(comment => !kept(comment.text));
    if (!unwanted.length) continue;
    removed += unwanted.length;
    if (mode === '--check') {
      for (const { line, text } of unwanted) failures.push(`${file}:${line} ${text.split('\n')[0].slice(0, 80)}`);
      continue;
    }
    const next = strip(source, unwanted);
    // WHY: esbuild refuses declaration-only files, and tsc checks them anyway.
    const declaration = /\.d\.[cm]?ts$/.test(file);
    if (!declaration && await compiled(file, source) !== await compiled(file, next)) {
      failures.push(`${file}: compiled output changed, not written`);
      continue;
    }
    writeFileSync(path.join(root, file), next);
    changed++;
  }
  if (mode === '--check') {
    if (failures.length) {
      console.error(`${failures.length} comments without WHY: or SAFETY:\n${failures.slice(0, 40).join('\n')}`);
      console.error('Delete them, or prefix a constraint the code cannot show with WHY:. `npm run comments:strip` removes the rest.');
      process.exit(1);
    }
    console.log('comments: ok');
    return;
  }
  console.log(`removed ${removed} comments in ${changed} files`);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
