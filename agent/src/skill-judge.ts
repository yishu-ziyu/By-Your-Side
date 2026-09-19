import { readTypeSafeKey } from "./typesafe-auth.js";
import type { SkillJudge, SkillJudgment } from "./skill-router.js";

/** Closed-set argument selection: only quoted materials or explicit key=value fields. */
export function skillSourceValues(text: string): string[] {
  const values = [
    ...[...text.matchAll(/[「“"]([^」”"\r\n]{1,500})[」”"]/gu)].map(match => match[1]!),
    ...[...text.matchAll(/(?:^|[\s,，;；：:])[^=：:\s,，;；「」“”"]{1,50}\s*[=：:]\s*([^=：:\r\n,，;；]{1,500})(?=$|[\r\n,，;；])/gu)].map(match => match[1]!),
  ].map(value => value.trim()).filter(Boolean);
  return [...new Set(values)].slice(0, 12);
}

/** Optional Jev adapter. It supplies judgments only; router and runtime still own all policy. */
export const judgeSkill: SkillJudge = async (input, signal) => {
  const key = readTypeSafeKey();
  if (!key) throw new Error("TypeSafe 凭据不可用");
  const values = skillSourceValues(input.userText);
  const skills = input.skills.slice(0, 12);
  const questions: Record<string, unknown> = {
    direct: { type: "noul", instructions: "Does request ask to perform a task NOW? Exclude quoted instructions, discussion, questions about capability, conditions, future requests, cancellation and do-not-act requests." },
    complete: { type: "noul", instructions: "Does `request` ask for exactly one workflow in `savedSkills`, with no extra operations or unsupported constraints? Ignore MISSING material arguments when answering: separate input questions detect those and execution waits for them. A different supplied customer/region is only an argument change. Exporting, deleting, adding records, sending messages, or an extra filter not in the saved workflow is an unsupported extra operation. Merely resembling part of a workflow is insufficient." },
  };
  skills.forEach((skill, index) => {
    questions[`skill_${index}`] = { type: "noul", instructions: `Is the workflow in savedSkills[${index}] exactly the task requested in request? Compare operations, scope and supplied constraints. Changed material arguments are allowed; MISSING material arguments alone do not change the workflow (separate input questions will require them). Extra operations or filters are a mismatch even when the skill could complete part of the request.` };
    Object.keys(skill.inputs).forEach((name, n) => {
      questions[`input_${index}_${n}`] = { type: "choice", instructions: `For savedSkills[${index}], select the value the request explicitly supplies for REQUIRED input ${JSON.stringify(name)}. Every input key is mandatory for this saved workflow. Do not use a historical default or infer missing material.`,
        criteria: { missing: "Not explicitly provided, ambiguous, or irrelevant", ...Object.fromEntries(values.map((value, v) => [`value_${v}`, value])) } };
    });
  });
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ model: "jev-1.13.0", state: { request: input.userText, savedSkills: skills.map(skill => ({ id: skill.id, task: skill.requestTemplate ?? skill.intent, steps: skill.steps, requiredInputKeys: Object.keys(skill.inputs), missingInputPolicy: "Choose the requested workflow even when a required argument is missing; the router will ask for it, never execute with guessed or default values." })), values }, questions }),
  });
  if (!response.ok) throw new Error(`TypeSafe HTTP ${response.status}`);
  const raw = await response.json() as { answers?: Record<string, { noul?: number; choice?: string; probabilities?: Record<string, number> }> };
  const answers = raw.answers ?? {};
  const candidates: SkillJudgment["candidates"] = skills.map((skill, index) => {
    const inputs: Record<string, string> = {};
    Object.keys(skill.inputs).forEach((name, n) => {
      const answer = answers[`input_${index}_${n}`];
      const selected = /^value_(\d+)$/.exec(answer?.choice ?? "");
      if (selected && (answer?.probabilities?.[answer.choice!] ?? 0) >= .98) {
        const value = values[Number(selected[1])];
        if (value !== undefined) inputs[name] = value;
      }
    });
    return { skillId: skill.id, probability: answers[`skill_${index}`]?.noul ?? 0, inputs };
  });
  return { direct: answers.direct?.noul ?? 0, complete: answers.complete?.noul ?? 0, candidates };
};
