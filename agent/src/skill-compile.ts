/**
 * 把一份示范记录编译成技能：确定性编译，不调模型。
 *
 * 产出三样，对应面板上的三层显示：
 *   1. steps   —— 人话步骤（默认显示）
 *   2. check   —— 完成凭证（机器可复算：跑完后那个对象必须还在）
 *   3. program —— browser_run 可执行的脚本（默认折叠）
 *
 * 编译规则（第一刀，只读任务）：
 *   - 只编译 click / type / press；submit 丢掉（示范里通常已有那次点击，重复提交更危险）
 *   - 目标只记语义锚点（tag + role + 可访问名）；解析在运行时按语义做，不留 DOM 路径与坐标
 *   - 示范时输入的值抽成 inputs；换材料改值，不改脚本
 *   - 完成凭证默认取最后一步的目标：找不到它就说明页面已经不像当初，脚本必须停
 */
import type { DemoStep } from "../../shared/demo-record.js";
import { forbiddenInSkill, normalizeSkillHost, validSkillId, type Skill, type SkillAnchor, type SkillStep } from "../../shared/skill.js";

export interface CompileInput {
  id: string;
  demoId: string;
  intent: string;
  hostname: string;
  steps: DemoStep[];
  now?: number;
}

function anchorOf(step: DemoStep): SkillAnchor | undefined {
  if (!step.anchor) return undefined;
  const { tag, role, name, inputType } = step.anchor;
  return { tag, ...(role ? { role } : {}), ...(name ? { name } : {}), ...(inputType ? { inputType } : {}) };
}

function inputKeyFor(anchor: SkillAnchor | undefined, taken: Set<string>): string {
  const base = (anchor?.name ?? anchor?.tag ?? "输入").slice(0, 24);
  let key = base;
  let n = 2;
  while (taken.has(key)) { key = `${base}${n}`; n += 1; }
  taken.add(key);
  return key;
}

export function compileSkill(input: CompileInput): Skill {
  const now = input.now ?? Date.now();
  const steps: SkillStep[] = [];
  const inputs: Record<string, string> = {};
  const taken = new Set<string>();
  let weakCount = 0;
  for (const step of input.steps) {
    const anchor = anchorOf(step);
    if (step.kind === "submit") continue; // 示范里的那次点击已经做过提交
    if (step.kind === "click" && anchor) {
      // 没名字也没角色的点击（裸 div、跨导航的残影）标成弱步骤：
      // 运行期认不出来就跳过，而不是编译期直接丢掉——真机上 B 站视频卡全是这种。
      const weak = !anchor.name && !anchor.role;
      if (weak) weakCount += 1;
      steps.push({ kind: "click", anchor, ...(weak ? { weak: true as const } : {}) });
    }
    else if (step.kind === "press") steps.push({ kind: "press", key: step.key ?? "Enter" });
    else if (step.kind === "type" && anchor) {
      const key = inputKeyFor(anchor, taken);
      inputs[key] = step.redacted ? "" : step.value ?? "";
      steps.push({ kind: "type", anchor, inputKey: key, ...(step.redacted ? { redacted: true as const } : {}) });
    }
  }
  // 凭证要能被认出来：优先最后一个"有可访问名"的目标，全是裸标签时才退回最后一步。
  const reversed = [...steps].reverse();
  const last = reversed.find(s => s.anchor?.name) ?? reversed.find(s => s.anchor);
  const check = {
    ...(last?.anchor ? { marker: last.anchor } : {}),
    text: last?.anchor
      ? `跑完后页面上必须还能找到${last.anchor.name ? `「${last.anchor.name}」` : ` ${last.anchor.tag} `}；找不到就说明这一页已经和示范时不一样，不算跑完。`
      : "跑完后每一步的目标都必须在；任何一步找不到目标就停。",
  };
  const host = normalizeSkillHost(input.hostname);
  const name = input.intent.trim().slice(0, 40) || `${host} 上的示范`;
  return {
    id: input.id,
    name,
    intent: input.intent.trim(),
    hostname: host,
    steps,
    inputs,
    check,
    program: buildProgram(input, steps, inputs, check.marker, host),
    version: 1,
    createdAt: now,
    updatedAt: now,
    sourceDemoId: input.demoId,
    runCount: 0,
    ...(weakCount > 0 ? { weakSteps: weakCount } : {}),
  };
}

/** 生成 browser_run 可用的函数体：先解析、再动作，解析不到就停。 */
function buildProgram(input: CompileInput, steps: SkillStep[], inputs: Record<string, string>, marker: SkillAnchor | undefined, host: string): string {
  const lines: string[] = [];
  lines.push(`// 由示范编译（${host}）`);
  lines.push(`// 目标：${input.intent.trim() || "（未填写）"}`);
  lines.push("// 每一步先按语义找对象；找不到就停，不猜、不点错。");
  lines.push(`const inputs = ${JSON.stringify(inputs, null, 2)};`);
  lines.push(`const resolveSpec = ${JSON.stringify(steps.map(s => s.anchor ?? null))};`);
  lines.push("const skipped = [];");
  lines.push("");
  lines.push(...RESOLVER_HELPER.split("\n"));
  lines.push("");
  const skips: string[] = [];
  steps.forEach((step, index) => {
    if (step.kind === "press") {
      lines.push(`await browser.press_key({ key: ${JSON.stringify(step.key ?? "Enter")} });`);
      return;
    }
    if (step.weak) {
      // 弱步骤：认不出来就跳过并记一笔，不因为一个没名字的对象让整件事停摆。
      lines.push(`const target${index} = await tryResolveStep(${index});`);
      lines.push(`if (!target${index}) { skipped.push(${index + 1}); } else {`);
      lines.push(`  ${step.kind === "click" ? `await browser.click({ target: target${index} });` : `await browser.fill({ target: target${index}, value: inputs[${JSON.stringify(step.inputKey ?? "")}] ?? "" });`}`);
      lines.push("}");
      skips.push(String(index + 1));
      return;
    }
    lines.push(`const target${index} = await resolveStep(${index});`);
    lines.push(step.kind === "click"
      ? `await browser.click({ target: target${index} });`
      : `await browser.fill({ target: target${index}, value: inputs[${JSON.stringify(step.inputKey ?? "")}] ?? "" });`);
  });

  lines.push("");
  const actionable = steps.filter(s => s.kind !== "press").length;
  if (actionable > 0) {
    lines.push(`if (skipped.length >= ${actionable}) {`);
    lines.push('  throw new Error("这一步都没认出来：技能什么都没做成，请重新示范一遍。");');
    lines.push("}");
  }
  if (marker) {
    lines.push("");
    lines.push(`if (!(await resolveAnchor(${JSON.stringify(marker)}))) {`);
    lines.push('  throw new Error("完成凭证不成立：跑完后没找到该有的对象，不算跑完。");');
    lines.push("}");
  }
  lines.push(`return { done: true, steps: ${steps.length}, ...(skipped.length ? { skipped } : {}) };`);
  return lines.join("\n");
}

/**
 * 运行时解析器：只按标签 + role + 可访问名匹配；命中后打标记，把"标记选择器"交给原工具。
 * 引号纪律：选择器写成不带值的形式（[data-sideagent-target]），页面代码里就不需要转义引号。
 * 旧写法嵌了 \" 转义，被外层字符串吃掉后页面代码变成 "...target="1"]"，真机报 js: SyntaxError: Unexpected number。
 * 打标记前先清掉上一次的标记，保证选择器唯一。
 */
const RESOLVER_HELPER = `async function resolveAnchor(anchor) {
  if (!anchor) return null;
  const source = [
    "(() => {",
    "const spec = " + JSON.stringify(anchor) + ";",
    'const norm = (s) => (s || "").replace(/\\\\s+/g, " ").trim();',
    'const candidates = Array.from(document.querySelectorAll(spec.tag));',
    "const hit = candidates.find((el) => {",
    '  if (spec.role && (el.getAttribute("role") || "").toLowerCase() !== spec.role) return false;',
    "  if (!spec.name) return candidates.length === 1;",
    '  return [el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.textContent].some((v) => norm(v) === spec.name);',
    "});",
    "if (!hit) return null;",
    'document.querySelectorAll("[data-sideagent-target]").forEach((el) => el.removeAttribute("data-sideagent-target"));',
    'hit.setAttribute("data-sideagent-target", "1");',
    'return "[data-sideagent-target]";',
    "})()",
  ].join("\\n");
  const result = await browser.js({ code: source });
  return result && result.value ? result.value : null;
}
async function resolveStep(index) {
  const target = await resolveAnchor(resolveSpec[index]);
  if (!target) throw new Error("第 " + (index + 1) + " 步的目标在页面上找不到了：脚本停下，没有继续操作。");
  return target;
}
/** 弱步骤用：认不出来就返回 null，由调用方跳过并记一笔。 */
async function tryResolveStep(index) {
  return await resolveAnchor(resolveSpec[index]);
}`;

/** 编译产物必须守住的红线：不出现坐标与 DOM 路径。 */
export function validateCompiledSkill(skill: Skill): string | null {
  if (!validSkillId(skill.id)) return "技能 id 非法";
  if (!skill.hostname) return "技能缺少站点";
  if (skill.steps.length === 0) return "示范里没有可编译的步骤";
  const bad = forbiddenInSkill(JSON.stringify({ steps: skill.steps, program: skill.program, check: skill.check }));
  return bad ? `编译产物里出现了${bad}` : null;
}
