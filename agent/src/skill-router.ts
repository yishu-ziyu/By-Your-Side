import { bindSkillInputs, normalizeSkillHost, sensitiveSkillInput, skillHealth, SkillInputError, type Skill, type SkillRun } from "../../shared/skill.js";

export type SkillRoute =
  | { status: "match"; skillId: string; inputs: Record<string, string>; confidence: number; reason: string }
  | { status: "needs_input"; skillId: string; missing: string[]; reason: string }
  | { status: "no_match" | "ambiguous"; reason: string };

export interface SkillRouterInput {
  userText: string;
  hostname: string;
  skills: Skill[];
  runs?: Record<string, SkillRun[]>;
}

/** An optional semantic selector. It chooses source spans, never invents argument values. */
export interface SkillJudgment {
  candidates: Array<{ skillId: string; probability: number; inputs: Record<string, string>; waiting?: number }>;
  direct: number;
  complete: number;
}

export type SkillJudge = (input: SkillRouterInput, signal: AbortSignal) => Promise<SkillJudgment>;

const noMatch = (reason: string): SkillRoute => ({ status: "no_match", reason });

const clean = (text: string) => text.trim().replace(/^(?:请|麻烦你|帮我)\s*/, "").replace(/[。.!！]\s*$/, "").trim();

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const probability = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

// Calibrated on the recorded live routing set, then checked on separate paraphrases.
// Execution still requires every calibrated judgment to pass; input extraction has its own
// stricter gate.
const ROUTE_MIN = .9;

// The clarification judgment is deliberately separate and never executes a saved workflow, so it
// uses its own bounded gate instead of the execution one. On the recorded live sets the highest
// non-fit clarification answer was .33 while every genuine missing-material case scored .89–.93,
// so .85 keeps a wide margin and cannot relax what the execution path requires.
const CLARIFY_MIN = .85;

/** Shared candidate validation. Returns the skill only when host, health and supplied values all pass. */
function resolveCandidate(input: SkillRouterInput, candidate: { skillId: string; inputs: Record<string, string> }): Skill | null {
  const skill = input.skills.find(item => item.id === candidate.skillId);

  if (!skill || normalizeSkillHost(skill.hostname) !== normalizeSkillHost(input.hostname) || skillHealth(input.runs?.[skill.id] ?? []).stale) return null;

  if (!candidate.inputs || typeof candidate.inputs !== "object" || Array.isArray(candidate.inputs)) return null;

  if (Object.values(candidate.inputs).some(value => typeof value !== "string" || !value || !input.userText.includes(value))) return null;

  return skill;
}

/** Only whole-request matching; added requirements must not disappear into a fuzzy match. */
export function matchSkillTemplate(request: string, template: string): Record<string, string> | null {
  const keys: string[] = [];
  const templateQuoted: boolean[] = [];
  const closingQuote: Record<string, string> = { "「": "」", "“": "”", '"': '"' };
  let previous = 0, source = "";
  const normalized = clean(template);

  if (!/[\p{L}\p{N}]/u.test(normalized.replace(/\{\{[^{}]+\}\}/g, ""))) return null;

  for (const match of normalized.matchAll(/\{\{([^{}]+)\}\}/g)) {
    const key = match[1]!;

    if (keys.includes(key)) return null;

    if (keys.length && match.index === previous) return null; // Adjacent slots have no unambiguous split.
    source += escape(normalized.slice(previous, match.index)) + "(.+?)";
    keys.push(key);
    const before = normalized[match.index! - 1] ?? "";
    templateQuoted.push(!!closingQuote[before] && closingQuote[before] === normalized[match.index! + match[0].length]);
    previous = match.index! + match[0].length;
  }

  source += escape(normalized.slice(previous));

  if (source.length > 3000 || keys.length > 12) return null;
  const found = new RegExp(`^${source}$`, "u").exec(clean(request));

  if (!found) return null;
  const inputs: Record<string, string> = {};

  for (const [index, key] of keys.entries()) {
    if (["__proto__", "constructor", "prototype"].includes(key)) return null;
    const material = found[index + 1]!.trim();
    const wrapped = /^(?:「[^「」]*」|“[^“”]*”|"[^"]*")$/u.test(material);

    // A fixed suffix cannot prove that free text contains only a value: "李四后导出"
    // can precede it. Only explicit quoted materials bypass semantic task coverage.
    if (!wrapped && !templateQuoted[index]) return null;

    if (templateQuoted[index] && /[「」“”"]/.test(material)) return null;
    const value = wrapped ? material.slice(1, -1) : material;

    if (!value || value.length > 500 || /[\r\n;；]/.test(value)) return null;
    inputs[key] = value;
  }

  return inputs;
}

function bindRoute(skill: Skill, supplied: Record<string, string>, confidence: number): SkillRoute {
  const missing = Object.keys(skill.inputs).filter(key => !Object.hasOwn(supplied, key) || sensitiveSkillInput(skill, key));

  // Automatic replay never silently inherits old materials or sensitive credentials.
  if (missing.length) return { status: "needs_input", skillId: skill.id, missing, reason: "本次请求没有提供全部材料" };

  try {
    return { status: "match", skillId: skill.id, inputs: bindSkillInputs(skill, supplied), confidence, reason: "整条要求与已保存做法一致" };
  } catch (error) {
    if (error instanceof SkillInputError && error.missing.length) return { status: "needs_input", skillId: skill.id, missing: error.missing, reason: error.message };

    return noMatch("参数校验未通过");
  }
}

export function composeSkillJudgment(input: SkillRouterInput, judgment: SkillJudgment): SkillRoute {
  if (!judgment || !probability(judgment.direct) || judgment.direct < ROUTE_MIN || !Array.isArray(judgment.candidates)) return noMatch("语义不确定或不是当前可直接执行的请求");

  // Execution path: the original calibrated gates, unchanged. A skill may only run when the
  // request is a now-request, covers exactly this workflow, is confidently identified, and
  // supplies every material. Missing a material still returns needs_input before any write.
  if (probability(judgment.complete) && judgment.complete >= ROUTE_MIN) {
    const eligible = judgment.candidates.filter(candidate => probability(candidate.probability) && candidate.probability >= ROUTE_MIN);

    if (eligible.length > 1) return { status: "ambiguous", reason: "多份做法都可能匹配，不自动执行" };

    if (eligible.length === 1) {
      const candidate = eligible[0]!;
      const skill = resolveCandidate(input, candidate);

      if (!skill) return noMatch("站点、版本、健康度或参数不满足");

      return bindRoute(skill, candidate.inputs, candidate.probability);
    }
  }

  // Clarification path: a request that clearly targets one saved workflow must ask for the
  // materials it did not supply instead of being silently reported as no match. This gate can
  // only ever return needs_input; it never executes, even if the model over-answers it.
  const unclear = judgment.candidates.filter(candidate => candidate.waiting !== undefined && probability(candidate.waiting) && candidate.waiting >= CLARIFY_MIN);

  if (unclear.length > 1) return { status: "ambiguous", reason: "多份做法都可能缺少材料，不自动执行" };

  if (unclear.length === 1) {
    const candidate = unclear[0]!;
    const skill = resolveCandidate(input, candidate);

    if (skill) {
      const route = bindRoute(skill, candidate.inputs, candidate.waiting!);

      return route.status === "needs_input" ? route : noMatch("没有可靠匹配");
    }
  }

  return noMatch("没有可靠匹配");
}

/** Pure selection with a bounded optional model judgment. No browser or persistence capability. */
export async function routeSkill(input: SkillRouterInput, options: { judge?: SkillJudge; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SkillRoute> {
  const userText = input.userText.trim();

  if (!userText || userText.length > 3000 || options.signal?.aborted) return noMatch("请求为空、过长或已取消");

  if (/^(?:不要|别|停止|取消|假如|如果|以后|明天|如何|怎么|能否介绍|解释|什么是|do not|don't|how |what |if )/i.test(userText)) return noMatch("不是当前可直接执行的完整请求");

  const skills = input.skills.filter(skill => normalizeSkillHost(skill.hostname) === normalizeSkillHost(input.hostname)
    && !skillHealth(input.runs?.[skill.id] ?? []).stale);

  if (!skills.length) return noMatch("当前站点没有健康技能");

  const local = skills.flatMap(skill => {
    const bindings = matchSkillTemplate(userText, skill.requestTemplate ?? skill.intent);

    return bindings ? [{ skill, bindings }] : [];
  });

  if (local.length > 1) return { status: "ambiguous", reason: "同一要求匹配多份做法" };

  if (local.length === 1) return bindRoute(local[0]!.skill, local[0]!.bindings, 1);

  if (!options.judge || skills.length > 12) return noMatch("没有确定匹配，或候选过多需要缩小范围");
  const timeout = AbortSignal.timeout(Math.min(1000, Math.max(1, options.timeoutMs ?? 900)));
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let onAbort: (() => void) | undefined;

  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("路由已超时或取消"));
      signal.addEventListener("abort", onAbort, { once: true });

      if (signal.aborted) onAbort();
    });

    const scoped = { ...input, skills };
    const judgment = await Promise.race([options.judge(scoped, signal), aborted]);

    return signal.aborted ? noMatch("迟到的路由已失效") : composeSkillJudgment(scoped, judgment);
  } catch { return noMatch(signal.aborted ? "路由已超时或取消，回原流程" : "路由不可用，回原流程"); }
  finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}
