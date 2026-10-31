/**
 * 回答里的依据：模型在事实后面写 <cite source anchor>，这里换成角标，回答下面直接列出原文那一句。
 * 对标 Gemini「核对回答」（不用点就看出哪句有依据、哪句对不上）和 NotebookLM 的引用（点角标看原文）。
 * 盲判第一轮里要悬停才看得到的出处没人用，所以原文默认摊开。
 *
 * 诚实边界：
 * - 原文只取本 run 真实读到并存下的文本（capturedCite），模型写的 anchor 只是定位用，找不到就说找不到。
 * - 「原文里没直接写」只比对数字，是提醒不是判错：数出来的总数本来就不在原文里。
 * - 只有回答里至少有一处出处时，才把没给出处、带数字的句子标出来，旧回答不受影响。
 */
import { capturedCite, proseCites, type AnswerSourceMap } from "../../../shared/answer-source.js";

const MONTHS: Record<string, string> = { jan: "1", feb: "2", mar: "3", apr: "4", may: "5", jun: "6", jul: "7", aug: "8", sep: "9", oct: "10", nov: "11", dec: "12" };

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** 读页工具的无障碍树带着 [ref=12]、text: 这类标记，给人看的原文去掉它们。 */
const readable = (text: string) => text.replace(/\[ref=\w+\]\s*/g, "").replace(/(^|\n)\s*text:\s*/g, "$1")
  .replace(/\s(?:url|level|checked|expanded|focused)=\S*/g, "").replace(/\b(?:link|heading|button|ListMarker|RootWebArea|paragraph|listitem|cell|row)\s+"([^"]*)"/g, "$1").replace(/\s+/g, " ");

/** 2 位以上或带小数点的数：单个数字（第 2 版、3 本）太容易在原文别处撞上，不比。 */
function numbers(text: string): string[] {
  return [...new Set((text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "").replace(/^0+(?=\d)/, "")).filter((n) => n.length >= 2 || n.includes(".")))];
}

function sourceNumbers(text: string): Set<string> {
  const months = (text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi) ?? []).map((m) => MONTHS[m.slice(0, 3).toLowerCase()]!);
  return new Set([...(text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "").replace(/^0+(?=\d)/, "")), ...months]);
}

/** 角标前面那句话：从上一个出处或句子边界到这个出处。 */
function claimBefore(prose: string, start: number, floor: number): string {
  let from = floor;
  for (const mark of "。！？；;\n") from = Math.max(from, prose.lastIndexOf(mark, start - 1) + 1);
  return prose.slice(from, start).replace(/<cite\b[^>]*>(?:\s*<\/cite>)?/g, "").replace(/[*`_#>]|^\s*(?:[-+]|\d+\.)\s+/g, "").trim();
}

type Item = { n: number; state: "ok" | "partial" | "missing"; claim: string; html: string; from: string; absent: string[] };

export interface Evidence {
  prose: string;
  /** 渲染并消毒后的正文 → 换回角标，末尾接上依据列表。 */
  finish(html: string): string;
}

/** counter 跨一条回答的各段正文共用，角标编号不重来。 */
export function withEvidence(prose: string, sources: AnswerSourceMap | undefined, nonce: string, counter = { n: 0 }): Evidence {
  // 边写边显示时，写到一半的 <cite 先藏起来，不露出标签原文。
  prose = prose.replace(/<cite\b[^>]*$/, "");
  const cites = proseCites(prose);
  if (!cites.length) return { prose, finish: (html) => html };

  const items: Item[] = [];
  let out = "", end = 0;

  // 模型常把几个出处一起堆在句末：连着写的一组出处共用前面那句话，数字到这一组原文的并集里去找。
  let group: { claim: string; members: Item[]; seen: Set<string> } | null = null;

  for (const cite of cites) {
    if (!group || prose.slice(end, cite.index).trim()) group = { claim: claimBefore(prose, cite.index, end), members: [], seen: new Set() };
    const match = capturedCite(cite, sources, 4);
    const n = ++counter.n;
    let item: Item;

    if (!match) item = { n, state: "missing", claim: group.claim, html: "", from: "", absent: [] };
    else {
      const { source, start, end: stop } = match;
      for (const value of sourceNumbers(source.text.slice(Math.max(0, start - 240), stop + 240))) group.seen.add(value);
      const before = readable(source.text.slice(Math.max(0, start - 70), start)), hit = readable(source.text.slice(start, stop)), after = readable(source.text.slice(stop, stop + 70));
      const host = /^https?:\/\//.test(source.from) ? new URL(source.from).host.replace(/^www\./, "") : source.from;
      item = { n, state: "ok", claim: group.claim, html: `${start > 70 ? "…" : ""}${esc(before)}<mark>${esc(hit)}</mark>${esc(after)}${stop + 70 < source.text.length ? "…" : ""}`, from: host, absent: [] };
    }
    items.push(item);
    group.members.push(item);
    const seen = group.seen, found = group.members.filter((m) => m.state !== "missing");
    const absent = found.length ? numbers(group.claim).filter((value) => !seen.has(value)) : [];
    found.forEach((m, i) => { m.state = absent.length ? "partial" : "ok"; m.absent = i ? [] : absent; });

    out += prose.slice(end, cite.index) + `${nonce}${n}`;
    end = cite.index + cite.length;
  }
  out += prose.slice(end);

  // 有数字、却一个出处都没跟的行（表格和代码块不算）。
  let fence = false;
  const uncited: string[] = [];
  out = out.split("\n").map((line) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence || /^\s*(\||#|```)/.test(line) || line.includes(`${nonce}`) || !numbers(line).length) return line;
    uncited.push(line.replace(/[*`_#>]|^\s*(?:[-+]|\d+\.)\s+/g, "").trim());
    return `${line}${nonce}`;
  }).join("\n");

  const mark = new RegExp(`${nonce}(\\d+)`, "g"), none = new RegExp(`${nonce}`, "g");

  return {
    prose: out,
    finish(html) {
      const body = html
        .replace(mark, (_all, n: string) => `<sup class="ev-ref" data-state="${items.find((item) => item.n === Number(n))!.state}">${n}</sup>`)
        .replace(none, `<sup class="ev-ref" data-state="none">无出处</sup>`);
      const rows = items.map((item) => item.state === "missing"
        ? `<div class="ev-item" data-state="missing"><span class="ev-n">${item.n}</span><div class="ev-body"><div class="ev-quote">读过的页面里没找到这句依据</div><div class="ev-meta">${esc(item.claim.slice(0, 60))}</div></div></div>`
        : `<div class="ev-item" data-state="${item.state}"><span class="ev-n">${item.n}</span><div class="ev-body"><div class="ev-quote">${item.html}</div><div class="ev-meta">${esc(item.from)}${item.absent.length ? `<span class="ev-warn"> · 原文里没直接写 ${esc(item.absent.join("、"))}</span>` : ""}</div></div></div>`);
      const loose = uncited.map((claim) => `<div class="ev-item" data-state="none"><span class="ev-n">?</span><div class="ev-body"><div class="ev-quote">没给出处</div><div class="ev-meta">${esc(claim.slice(0, 60))}</div></div></div>`);
      return `${body}<div class="ev-list" aria-label="依据">${rows.concat(loose).join("")}</div>`;
    },
  };
}
