import { execFileSync } from "node:child_process";

const RUNTIME = /^(extension\/src|agent|native)\/.*\.(ts|tsx|mts|js)$/;
const NOT_RUNTIME = /(\.sim\.ts|\.test\.|\/vendor\/)/;
const LITERAL = String.raw`(["'\`])((?:\\.|(?!\1).)*)\1`;
const COMPARED = new RegExp(String.raw`(?:\.(?:includes|startsWith|endsWith|indexOf)\(|[!=]==?\s*|\bcase\s+)${LITERAL}`, "g");
const REGEX = /(?:^|[\s(=,:!&|])\/((?:\\.|[^/\n])+)\/[a-z]*\s*(?:\.|[,;)]|$)/g;
const SITE = /\b[a-z0-9-]+\.(com|cn|org|net|io|tv|me|co)\b|\b(youtube|bilibili|douyin|tiktok|xiaohongshu|taobao|jd|weibo|zhihu|github|google|baidu|gmail)\b|抖音|小红书|淘宝|京东|微博|知乎|百度|哔哩/i;
const SENTENCE = /[一-鿿]{2,}/;

const args = process.argv.slice(2);

function git(...command) {
  return execFileSync("git", command, { encoding: "utf8", maxBuffer: 1 << 28 });
}

function baseCommit() {
  if (args[0]) return args[0];
  try {
    return git("merge-base", "origin/main", "HEAD").trim();
  } catch {
    console.log("check:hardcoded-matching 没查：找不到 origin/main。");
    process.exit(0);
  }
}

function reason(line) {
  if (line.includes("hardcode-ok") || /^\s*(\/\/|\/\*|\*)/.test(line)) return null;
  const hit = (text) => (SITE.test(text) ? "网站名" : SENTENCE.test(text) ? "用户原句" : null);
  const texts = [...line.matchAll(REGEX)].map((match) => match[1]).concat([...line.matchAll(COMPARED)].map((match) => match[2]));
  for (const text of texts) if (hit(text)) return hit(text);
  return null;
}

const range = args[1] ? `${baseCommit()}..${args[1]}` : baseCommit();
const problems = [];
let added = 0;
let removed = 0;
let file = null;
let lineNumber = 0;

for (const line of git("diff", "--unified=0", "--no-color", range).split("\n")) {
  if (line.startsWith("+++ ")) {
    file = line.slice(6);
  } else if (line.startsWith("@@")) {
    lineNumber = Number(line.match(/\+(\d+)/)[1]);
  } else if (file && RUNTIME.test(file) && !NOT_RUNTIME.test(file)) {
    if (line.startsWith("+")) {
      added += 1;
      const why = reason(line.slice(1));
      if (why) problems.push(`${file}:${lineNumber} ${why}：${line.slice(1).trim().slice(0, 100)}`);
      lineNumber += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
}

console.log(`运行代码净增 ${added - removed} 行（新增 ${added}，删除 ${removed}）。`);
if (problems.length) {
  console.error("这些新增代码在按网站名或用户原句做判断。请修产生这类问题的机制；确实需要时在行尾写 // WHY: hardcode-ok 加原因：");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
