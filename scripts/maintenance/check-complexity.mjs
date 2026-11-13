import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baselinePath = path.join(root, "scripts/maintenance/complexity-baseline.json");
const { transformSync } = createRequire(new URL("../../extension/package.json", import.meta.url))("esbuild");

const MAX_SELF_CC = 50;
const SOURCE_ROOTS = ["shared", "agent/src", "extension/src"];

function walkFiles(dir, out = []) {
  for (const ent of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${ent.name}`;
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === "dist" || ent.name === "vendor") continue;
      walkFiles(rel, out);
    } else if (/\.(?:ts|tsx)$/.test(ent.name) && !ent.name.endsWith(".d.ts") && !ent.name.endsWith(".sim.ts")) {
      out.push(rel);
    }
  }
  return out;
}

function tokenize(code) {
  const tokens = [];
  let i = 0;
  let line = 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\n") { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i++;
      while (i < code.length && code[i] !== q) {
        if (code[i] === "\\") i += 2;
        else { if (code[i] === "\n") line++; i++; }
      }
      i++;
      tokens.push({ t: "str", v: q, line });
      continue;
    }
    if (ch === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
      if (code[i + 1] === "/") { while (i < code.length && code[i] !== "\n") i++; }
      else { i += 2; while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) { if (code[i] === "\n") line++; i++; } i += 2; }
      continue;
    }
    if (ch === "/") {
      const prev = tokens.at(-1);
      const canRegex = !prev || (prev.t === "p" && "({[=,:;!&|?+-*~^%<>".includes(prev.v)) || (prev.t === "id" && ["return", "case", "throw", "typeof", "in", "of", "delete", "void", "yield", "await", "else", "do"].includes(prev.v));
      if (canRegex) {
        i++;
        let inCls = false;
        while (i < code.length) {
          if (code[i] === "\\") { i += 2; continue; }
          if (code[i] === "[") inCls = true;
          else if (code[i] === "]") inCls = false;
          else if (code[i] === "/" && !inCls) { i++; while (/[a-z]/i.test(code[i] ?? "")) i++; break; }
          else if (code[i] === "\n") break;
          i++;
        }
        tokens.push({ t: "rx", v: "/", line });
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const s = i;
      while (i < code.length && /[A-Za-z0-9_$]/.test(code[i])) i++;
      tokens.push({ t: "id", v: code.slice(s, i), line });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      while (i < code.length && /[0-9a-zA-Z._]/.test(code[i])) i++;
      tokens.push({ t: "num", v: "0", line });
      continue;
    }
    const two = code.slice(i, i + 2);
    if (["&&", "||", "??", "=>", "?.", "==", "!=", "<=", ">="].includes(two)) {
      tokens.push({ t: "p", v: two, line });
      i += 2;
      continue;
    }
    tokens.push({ t: "p", v: ch, line });
    i++;
  }
  return tokens;
}

function arrowName(toks, arrowIdx) {
  let p = arrowIdx - 1;
  if (toks[p]?.v === ")") {
    let d = 1;
    p--;
    while (p >= 0 && d > 0) { if (toks[p].v === ")") d++; else if (toks[p].v === "(") d--; p--; }
  } else if (toks[p]?.t === "id") {
    p--;
  }
  if (toks[p]?.v === "async") p--;
  if ((toks[p]?.v === "=" || toks[p]?.v === ":") && toks[p - 1]?.t === "id") return toks[p - 1].v;
  if (toks[p]?.v === "," || toks[p]?.v === "(") {
    let q = p;
    let d = toks[q]?.v === "(" ? 1 : 0;
    if (d === 0) {
      d = 1;
      q--;
      while (q >= 0 && d > 0) { if (toks[q].v === ")") d++; else if (toks[q].v === "(") d--; q--; }
    } else q--;
    if (toks[q]?.t === "id") return `${toks[q].v}:cb`;
  }
  return "<arrow>";
}

// WHY: 只计每个函数自身的分支数，不连坐嵌套子函数，避免把前端模块闭包容器误判为高复杂度，同时阻止任何单个函数体继续膨胀。
export function scanSelfComplexity() {
  const files = SOURCE_ROOTS.flatMap(dir => walkFiles(dir)).sort();
  const measured = new Map();
  const record = (key, self) => {
    const prev = measured.get(key) ?? 0;
    if (self > prev) measured.set(key, self);
  };

  for (const file of files) {
    const raw = readFileSync(path.join(root, file), "utf8");
    const { code } = transformSync(raw, { loader: file.endsWith(".tsx") ? "tsx" : "ts", legalComments: "none", keepNames: false });
    const toks = tokenize(code);
    const stack = [];
    let brace = 0;
    let paren = 0;
    let bracket = 0;

    const popConcise = (nextTok) => {
      while (stack.length && stack.at(-1).kind === "concise") {
        const top = stack.at(-1);
        if (brace === top.brace && paren === top.paren && bracket === top.bracket && [",", ";", ")", "]", "}"].includes(nextTok)) {
          const done = stack.pop();
          record(done.key, done.self);
        } else break;
      }
    };

    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      if (tk.t === "p" && [",", ";", ")", "]", "}"].includes(tk.v)) popConcise(tk.v);
      if (tk.t === "p" && tk.v === "=>" && toks[i + 1]?.v !== "{") {
        const name = arrowName(toks, i);
        const qual = [...stack.map(s => s.name), name].join(">");
        stack.push({ kind: "concise", name, key: `${file}#${qual}`, brace, paren, bracket, self: 1 });
        continue;
      }
      if (tk.t === "p" && tk.v === "(") { paren++; continue; }
      if (tk.t === "p" && tk.v === ")") { paren--; continue; }
      if (tk.t === "p" && tk.v === "[") { bracket++; continue; }
      if (tk.t === "p" && tk.v === "]") { bracket--; continue; }
      if (tk.t === "p" && tk.v === "{") {
        let fnStart = null;
        if (toks[i - 1]?.v === "=>") {
          fnStart = { name: arrowName(toks, i - 1) };
        } else if (toks[i - 1]?.v === ")") {
          let p = i - 2;
          let d = 1;
          while (p >= 0 && d > 0) { if (toks[p].v === ")") d++; else if (toks[p].v === "(") d--; p--; }
          if (toks[p]?.t === "id" && !["if", "for", "while", "switch", "catch"].includes(toks[p].v)) {
            if (toks[p - 1]?.v === "function" || toks[p - 1]?.v === "*" || toks[p]?.v === "function") {
              let name = toks[p].v === "function" ? "<fn>" : toks[p].v;
              if (name === "<fn>") {
                let q = toks[p].v === "function" ? p - 1 : p - 2;
                if (toks[q]?.v === "async") q--;
                if ((toks[q]?.v === "=" || toks[q]?.v === ":") && toks[q - 1]?.t === "id") name = toks[q - 1].v;
              }
              fnStart = { name };
            } else {
              const prev = toks[p - 1];
              if (!prev || [";", "{", "}", ",", "async", "static", "get", "set"].includes(prev.v)) fnStart = { name: toks[p].v };
            }
          }
        }
        brace++;
        if (fnStart) {
          const qual = [...stack.map(s => s.name), fnStart.name].join(">");
          stack.push({ kind: "block", name: fnStart.name, key: `${file}#${qual}`, targetBrace: brace - 1, self: 1 });
        }
        continue;
      }
      if (tk.t === "p" && tk.v === "}") {
        brace--;
        while (stack.length && stack.at(-1).kind === "block" && stack.at(-1).targetBrace === brace) {
          const done = stack.pop();
          record(done.key, done.self);
        }
        continue;
      }
      if (stack.length) {
        if ((tk.t === "id" && ["if", "for", "while", "case", "catch"].includes(tk.v) && toks[i - 1]?.v !== ".")
          || (tk.t === "p" && ["&&", "||", "??", "?"].includes(tk.v))) {
          stack.at(-1).self += 1;
        }
      }
    }
    popConcise(";");
  }

  return measured;
}

function main() {
  const measured = scanSelfComplexity();
  if (process.argv.includes("--write-baseline")) {
    const entries = [...measured.entries()]
      .filter(([, cc]) => cc > MAX_SELF_CC)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    writeFileSync(baselinePath, `${JSON.stringify({ maxSelfCc: MAX_SELF_CC, legacy: Object.fromEntries(entries) }, null, 2)}\n`);
    console.log(`complexity: wrote ${entries.length} legacy entries (max=${entries[0]?.[1] ?? 0})`);
    return;
  }

  const raw = JSON.parse(readFileSync(baselinePath, "utf8"));
  const legacy = raw.legacy ?? {};
  const failures = [];

  for (const [key, cc] of measured) {
    const allowed = Object.hasOwn(legacy, key) ? legacy[key] : MAX_SELF_CC;
    if (cc > allowed) failures.push(`exceeded: ${key} has self CC ${cc} > allowed ${allowed}`);
  }

  for (const [key, allowed] of Object.entries(legacy)) {
    const actual = measured.get(key);
    if (actual === undefined || actual <= MAX_SELF_CC) {
      failures.push(`stale baseline: ${key} is now ${actual ?? "removed"} (<= ${MAX_SELF_CC}); remove it from complexity-baseline.json or run --write-baseline`);
    } else if (actual < allowed - 10) {
      failures.push(`shrunk baseline: ${key} dropped from ${allowed} to ${actual}; tighten complexity-baseline.json (--write-baseline)`);
    }
  }

  if (failures.length) {
    console.error(`complexity check failed (${failures.length}):\n${failures.join("\n")}`);
    process.exit(1);
  }
  const maxCc = Math.max(0, ...measured.values());
  console.log(`complexity: ok (${measured.size} functions, legacy=${Object.keys(legacy).length}, max=${maxCc})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
