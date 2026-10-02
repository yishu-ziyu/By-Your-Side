import { withinValidity, type MemoryEntry } from "../../shared/memory.js";
import type { RequiredFormField } from "../../shared/protocol.js";

/** 只编译用户确认过的明确引用字段；不把任意方法猜成强制表单规则。 */
export function requiredFormFields(entries: MemoryEntry[], userMessages: readonly string[]): RequiredFormField[] {
  const rules: RequiredFormField[] = [];

  for (const entry of entries) {
    if (entry.kind !== "method" || entry.status !== "active" || entry.experience || !withinValidity(entry.validity, Date.now())) continue;

    if (/如果|除非|只有|仅当|仅在|需要时|必要时|\b(?:if|unless|only when|when needed)\b/iu.test(entry.text)) continue;

    for (const match of entry.text.matchAll(/(?:填写|填上|填|fill(?:\s+in)?)\s*[「“"']([^」”"'\n]{1,80})[」”"']/giu)) {
      const label = match[1]!.trim();
      const before = entry.text.slice(0, match.index).split(/[，,。；;\n]/u).at(-1) ?? "";
      const after = entry.text.slice(match.index! + match[0].length).split(/[，,。；;\n]/u)[0] ?? "";

      if (!label || /不|别|勿|无需|\b(?:not|don't|won't|never|without)\b/iu.test(before + after)) continue;

      const latest = [...userMessages].reverse().flatMap(message => message.split(/[。；;\n]/u).reverse())
        .find(clause => /^(?:这次|本次|这回)/u.test(clause.trim()) && clause.includes(label));

      const at = latest?.indexOf(label) ?? -1;
      const lead = latest?.slice(0, at).trim() ?? "";
      const tail = latest?.slice(at + label.length).trim() ?? "";
      const omitAfter = /^(?:就|先)?(?:留空|(?:不用|不要|不必|不需要|不)(?:填写|填上|填))(?:[，,。；;\s]|$)/u.test(tail);
      const omitBefore = /^(?:这次|本次|这回)(?:就|先)?(?:不用|不要|不必|不需要|别|不)(?:填写|填上|填)\s*[「“"']?$/u.test(lead);
      const override = !!latest && (omitAfter || omitBefore);

      if (override) continue;
      const rule: RequiredFormField = { label };

      if (entry.scope.kind === "site") rule.hostname = entry.scope.hostname;

      if (!rules.some(existing => existing.label === label && existing.hostname === rule.hostname)) rules.push(rule);
    }
  }

  return rules;
}
