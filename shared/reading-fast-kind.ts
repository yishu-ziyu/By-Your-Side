import { READING_KIND_SELECTION_LIMIT, type ReadingKind } from "./reading.js";

export type FastKindVerdict =
  | { decided: true; kind: ReadingKind }
  | { decided: false; fallback: ReadingKind };

const ZH_ADDRESS = /(?:路|街|大道|巷|弄|胡同|里)\s*[0-9０-９一二三四五六七八九十百]+\s*(?:号|弄|巷)/;
const EN_ADDRESS = /\b\d{1,5}\s+[A-Za-z][A-Za-z.\s]{1,32}\b(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Pl|Plaza)\b/i;
const SENTENCE_END = /[。！？!?]/;
const QUANTITY = /\d+(?:\.\d+)?\s*(?:%|％|倍|万|亿|million|billion|trillion|percent)/i;
const QUANTITY_ALL = new RegExp(QUANTITY.source, "gi");
const CLAIM_WORDS_MIN = 6;

function wordsAroundQuantity(text: string): number {
  return text.replace(QUANTITY_ALL, "").replace(/[\d\s.,，、:：()（）%％\-—~～]/g, "").length;
}

export function judgeReadingKindFast(raw: string): FastKindVerdict {
  const text = raw.trim();
  if (!text || text.length > READING_KIND_SELECTION_LIMIT) {
    return { decided: true, kind: "none" };
  }

  if (text.length <= 120 && !SENTENCE_END.test(text) && (ZH_ADDRESS.test(text) || EN_ADDRESS.test(text))) {
    return { decided: true, kind: "address" };
  }

  if (text.length >= 8 && !/[\n\t]/.test(text) && QUANTITY.test(text) && wordsAroundQuantity(text) >= CLAIM_WORDS_MIN) {
    return { decided: true, kind: "claim" };
  }

  return { decided: false, fallback: "none" };
}
