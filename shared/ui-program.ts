import { createParser } from "./vendor/openui-lang-core/index.mjs";
import { ANSWER_UI_SCHEMA } from "./answer-ui-schema.js";
import { splitAnswer } from "./answer-cards.js";

const parser = createParser(ANSWER_UI_SCHEMA, "root");

export function programIssue(text: string): { evidence: string; correction: string } | null {
  for (const part of splitAnswer(text)) {
    if (!("card" in part) || !part.card?.closed) continue;

    for (const block of part.card.blocks) {
      if (block.kind !== "app" || block.surface !== "ui") continue;
      const problems = parser.parse(block.html).meta.errors.filter((issue) => issue.severity !== "warning").map((issue) => issue.message);

      if (problems.length) return { evidence: `${block.title}: ${problems.join(" ")}`.slice(0, 300), correction: `The interface "${block.title}" will not show as written: ${problems.slice(0, 6).join(" ")} Rewrite the whole <ui> block with these fixed and keep the conclusion sentence outside it.` };
    }
  }

  return null;
}
