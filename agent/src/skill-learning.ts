import { createHash } from "node:crypto";
import { anchorFor, isSensitiveField, type DemoStep } from "../../shared/demo-record.js";
import { SKILL_OUTPUT_CONTRACT_VERSION, forbiddenInSkill, normalizeSkillHost, type Skill, type SkillCandidate } from "../../shared/skill.js";
import type { PageContext, ToolContract, ToolName } from "../../shared/protocol.js";
import type { ElementExpectation } from "../../shared/element-state.js";
import { compileSkill, validateCompiledSkill } from "./skill-compile.js";

export interface SkillEvidence {
  toolCallId: string;
  name: ToolName;
  params: Record<string, unknown>;
  result?: unknown;
  target?: ToolContract["read_element"]["data"];
  /** Assigned only by the browser-program host, never read from generated JS parameters. */
  origin?: "readonly-poll";
  error?: string;
}

const READ_ONLY = new Set(["snapshot", "read_element", "list_tabs", "get_active_tab", "screenshot", "network", "scroll"]);

const SAFE_CLICK = /^(?:搜索|查询|查找|筛选|应用筛选|下一页|上一页|search|find|filter|apply filters|next page|previous page)$/i;

/** Automatic routing requires current output coverage, including for legacy demonstrations. */
export function autoSkillEligible(skill: Skill): boolean {
  return skill.learnedOutputContractVersion === SKILL_OUTPUT_CONTRACT_VERSION && hasReplayableWorkflow(skill);
}

/** Structural evidence can be checked before the separate output judgment certifies it. */
function hasReplayableWorkflow(skill: Skill): boolean {
  if (!skill.check.expect || !skill.check.marker?.name || !skill.requestTemplate || skill.weakSteps || skill.droppedSteps) return false;

  if (validateCompiledSkill(skill)) return false;

  return skill.steps.every((step, index) => {
    if (step.redacted || step.weak) return false;

    if (step.kind === "press") return step.key === "Enter" && index > 0 && skill.steps[index - 1]?.anchor?.inputType === "search";

    if (!step.anchor?.name || forbiddenInSkill(JSON.stringify(step.anchor))) return false;

    if (step.kind === "click") return SAFE_CLICK.test(step.anchor.name);

    return ["input", "textarea"].includes(step.anchor.tag) && step.anchor.inputType !== "password"
      && !/密码|口令|密钥|验证码|token|secret|password|credit.?card/i.test(step.anchor.name);
  });
}

/** Bounded, transient execution evidence. Raw values never become a stored proposal. */
export class SkillLearningTrace {
  private run: { id: string; goal: string; context: PageContext } | null = null;
  private steps: DemoStep[] = [];
  private ids: string[] = [];
  private proof: { event: SkillEvidence; expect: ElementExpectation; source: "explicit-check" | "deterministic-readback" } | null = null;
  private invalid = false;
  private documentId: string | null = null;

  begin(id: string, goal: string, context: PageContext): void {
    this.run = { id, goal, context }; this.steps = []; this.ids = []; this.proof = null; this.invalid = false; this.documentId = null;
  }
  cancel(): void { this.invalid = true; }
  active(): boolean { return !!this.run && !this.invalid; }

  observe(event: SkillEvidence): ToolContract["read_element"]["params"] | void {
    if (!this.active()) return;

    if (this.ids.length >= 80) { this.invalid = true;

 return; }

    if (event.error) {
      // A failed read has not changed the page. Discard its proof and require a
      // fresh successful read; failed/unknown writes still invalidate the whole run.
      this.proof = null;

      if (!READ_ONLY.has(event.name) && event.origin !== "readonly-poll") this.invalid = true;

      return;
    }

    const data = event.result as Partial<ToolContract["read_element"]["data"]> | undefined;
    const tabId = event.params.tabId ?? event.target?.tabId ?? data?.tabId;

    if (tabId !== undefined && tabId !== this.run!.context.tabId) { this.invalid = true;

 return; }

    const documentId = event.target?.documentId ?? data?.documentId;

    if (documentId) {
      if (this.documentId && this.documentId !== documentId) { this.invalid = true;

 return; }

      this.documentId = documentId;
    }

    if (event.name === "read_element") {
      if (data?.documentId && data.anchorSource && this.steps.length) {
        if (data.check?.matched && event.params.expect) this.proof = { event, expect: event.params.expect as ElementExpectation, source: "explicit-check" };
        else if (!event.params.expect && !["input", "textarea", "select", "button"].includes(data.tagName ?? "")) {
          // The host can check a real post-action result even if the model omitted
          // expect. All provided materials must actually appear in this result node.
          // Keep the source explicit: this is not a fabricated browser check receipt.
          const materials = this.steps.filter(step => step.kind === "type").map(step => step.value ?? "");

          if (materials.length && materials.every(value => value.length >= 2 && data.textContent?.includes(value))) {
            this.proof = { event, expect: { property: "textContent", contains: materials[0]! }, source: "deterministic-readback" };
          }
        }
      }

      return;
    }

    if (event.name === "snapshot" && this.steps.length >= 3 && !this.proof) {
      const snapshot = event.result as Partial<ToolContract["snapshot"]["data"]> | undefined;
      // Only a unique named result/live-status node from THIS actual AX snapshot.
      // Never infer success from the snapshot text or from values inside form inputs.
      const refs = [...(snapshot?.text ?? "").matchAll(/^\s*\[ref=([1-9]\d{0,9})\]\s+(?:status|alert)\s+"[^"\n]+"/gm)];

      if (refs.length === 1 && snapshot?.tabId === this.run!.context.tabId) {
        return { tabId: snapshot.tabId, target: `@${refs[0]![1]}`, properties: ["textContent"] };
      }
    }

    if (READ_ONLY.has(event.name)) return;

    if (!this.steps.length && event.name === "switch_tab" && event.params.tabId === this.run!.context.tabId) return;

    if (!this.steps.length && event.name === "worker_tabs" && ["inspect", "claim"].includes(String(event.params.action))) return;
    this.proof = null;

    if (this.steps.length >= 20 || !["fill", "click", "press_key"].includes(event.name)) { this.invalid = true;

 return; }

    if (event.name === "press_key") {
      if (event.params.key !== "Enter" || this.steps.at(-1)?.anchor?.inputType !== "search") { this.invalid = true;

 return; }

      this.steps.push({ at: Date.now(), kind: "press", key: "Enter" }); this.ids.push(event.toolCallId);

 return;
    }

    const source = event.target?.anchorSource;

    if (!source || !event.target?.documentId || isSensitiveField(source)) { this.invalid = true;

 return; }

    const anchor = anchorFor(source);

    if (!anchor.name || forbiddenInSkill(JSON.stringify(anchor))) { this.invalid = true;

 return; }

    if (event.name === "click") {
      if (!SAFE_CLICK.test(anchor.name) || (event.result as { held?: boolean })?.held) { this.invalid = true;

 return; }

      this.steps.push({ at: Date.now(), kind: "click", anchor });
    } else {
      const value = event.params.value;

      if (typeof value !== "string" || !value || value.length > 500 || /[\r\n]|sk-[A-Za-z0-9]|Bearer\s|password\s*=/i.test(value)) { this.invalid = true;

 return; }

      if (this.steps.some(step => step.kind === "type" && JSON.stringify(step.anchor) === JSON.stringify(anchor))) { this.invalid = true;

 return; }

      this.steps.push({ at: Date.now(), kind: "type", anchor, value });
    }

    this.ids.push(event.toolCallId);
  }

  finish(completedRunId: string | null, completed: boolean): SkillCandidate | null {
    const run = this.run;
    this.run = null;

    if (!run || !completed || completedRunId !== run.id || this.invalid || this.steps.length < 3 || !this.proof) return null;
    const { event: proof, expect } = this.proof;
    const data = proof.result as ToolContract["read_element"]["data"];

    if (!data.anchorSource || ["input", "textarea", "select"].includes(data.tagName) || expect.property !== "textContent") return null;
    const marker = anchorFor(data.anchorSource);

    if (!marker.name || isSensitiveField(data.anchorSource)) return null;
    let hostname: string;

    try { hostname = normalizeSkillHost(new URL(run.context.url).hostname); } catch { return null; }

    const initial = compileSkill({ id: "candidate", demoId: `run-${run.id}`, intent: run.goal, hostname, steps: this.steps });

    // Reusable result checks must cover every material, not just the first field.
    if (!Object.values(initial.inputs).every(value => value.length >= 2 && data.textContent.includes(value))) return null;
    const expected = "contains" in expect ? expect.contains : expect.equals;
    const matched = Object.entries(initial.inputs).filter(([, value]) => value === expected);

    if (matched.length !== 1 || typeof expected !== "string") return null;
    let template = run.goal;

    for (const [key, value] of Object.entries(initial.inputs)) {
      if (!value || !template.includes(value) || marker.name.includes(value)) return null;

      // Each material has one unambiguous slot; an omitted condition is not a recipe.
      if (template.split(value).length !== 2) return null;
      template = template.replace(value, `{{${key}}}`);
    }

    if (/[\r\n]|sk-[A-Za-z0-9]|Bearer\s|密码|密钥|口令|验证码|token|secret|password|api.?key/i.test(template)) return null;
    const inputKey = matched[0]![0];

    const check: Skill["check"] = { marker, text: `核对「${marker.name}」中的全部本次材料`, inputKey, inputKeys: Object.keys(initial.inputs),
      expect: "contains" in expect ? { property: "textContent", contains: `{{${inputKey}}}` } : { property: "textContent", equals: `{{${inputKey}}}` } };

    const redactedSteps = this.steps.map(step => step.kind === "type" ? { ...step, value: "" } : step);
    const compiled = compileSkill({ id: "candidate", demoId: `run-${run.id}`, intent: template, hostname, steps: redactedSteps, check, requestTemplate: template });
    const hash = createHash("sha256").update(JSON.stringify({ hostname, template, steps: compiled.steps, check })).digest("hex").slice(0, 24);
    const skill = { ...compiled, id: `learned-${hash}`, sourceRunId: run.id };

    // 结构资格在这里判；"这条要求被做法完整覆盖"由学习收尾的语义判断决定，
    // 通过后才置 learnedOutputContractVersion，之后 autoSkillEligible 才放行自动复用。
    if (!hasReplayableWorkflow(compiled)) return null;

    return { skill, sourceRunId: run.id, createdAt: Date.now(), evidence: { toolCallIds: [...this.ids, proof.toolCallId], verifiedAt: Date.now(), actionCount: this.steps.length } };
  }
}
