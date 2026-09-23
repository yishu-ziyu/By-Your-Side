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
import { bindSkillInputs, forbiddenInSkill, normalizeSkillHost, validSkillId, type Skill, type SkillAnchor, type SkillStep, type SkillCheck } from "../../shared/skill.js";
import { validateElementRead } from "../../shared/element-state.js";

export interface CompileInput {
  id: string;
  demoId: string;
  intent: string;
  hostname: string;
  steps: DemoStep[];
  now?: number;
  check?: SkillCheck;
  requestTemplate?: string;
}

function anchorOf(step: DemoStep): SkillAnchor | undefined {
  if (!step.anchor) return undefined;
  const { tag, role, name, inputType } = step.anchor;

  const anchor: SkillAnchor = { tag };

  if (role) anchor.role = role;

  if (name) anchor.name = name;

  if (inputType) anchor.inputType = inputType;

  return anchor;
}

function inputKeyFor(anchor: SkillAnchor | undefined, taken: Set<string>): string {
  const raw = (anchor?.name ?? anchor?.tag ?? "输入").slice(0, 24);
  const base = ["__proto__", "prototype", "constructor"].includes(raw) ? "输入" : raw;
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
      const clickStep: SkillStep = { kind: "click", anchor };

      if (weak) clickStep.weak = true;
      steps.push(clickStep);
    }
    else if (step.kind === "press") steps.push({ kind: "press", key: step.key ?? "Enter" });
    else if (step.kind === "type" && anchor) {
      const key = inputKeyFor(anchor, taken);
      inputs[key] = step.redacted ? "" : step.value ?? "";
      const typeStep: SkillStep = { kind: "type", anchor, inputKey: key };

      if (step.redacted) typeStep.redacted = true;
      steps.push(typeStep);
    }
  }

  // 凭证要能被认出来：优先最后一个"有可访问名"的目标，全是裸标签时才退回最后一步。
  const reversed = [...steps].reverse();
  const last = reversed.find(s => s.anchor?.name) ?? reversed.find(s => s.anchor);

  const check: SkillCheck = input.check ?? { text: last?.anchor
    ? `跑完后页面上必须还能找到${last.anchor.name ? `「${last.anchor.name}」` : ` ${last.anchor.tag} `}；找不到就说明这一页已经和示范时不一样，不算跑完。`
    : "跑完后每一步的目标都必须在；任何一步找不到目标就停。" };

  if (!input.check && last?.anchor) check.marker = last.anchor;

  const host = normalizeSkillHost(input.hostname);
  const name = input.intent.trim().slice(0, 40) || `${host} 上的示范`;

  const skill: Skill = {
    id: input.id,
    name,
    intent: input.intent.trim(),
    hostname: host,
    steps,
    inputs,
    check,
    program: buildProgram(input, steps, inputs, check.marker, host, check),
    version: 1,
    createdAt: now,
    updatedAt: now,
    sourceDemoId: input.demoId,
    runCount: 0,
  };

  if (input.requestTemplate) skill.requestTemplate = input.requestTemplate;

  if (weakCount > 0) skill.weakSteps = weakCount;

  return skill;
}

/** 生成 browser_run 可用的函数体：先解析、再动作，解析不到就停。 */
function buildProgram(input: CompileInput, steps: SkillStep[], inputs: Record<string, string>, marker: SkillAnchor | undefined, host: string, check: SkillCheck): string {
  const lines: string[] = [];
  lines.push(`// 由示范编译（${host}）`);
  lines.push(`// 目标：${input.intent.trim().replace(/[\r\n\u2028\u2029]/g, " ") || "（未填写）"}`);
  lines.push("// 每一步先按语义找对象；找不到就停，不猜、不点错。");
  lines.push(`const inputs = ${JSON.stringify(inputs, null, 2)};`);
  lines.push(`const resolveSpec = ${JSON.stringify(steps.map(s => s.anchor ?? null))};`);
  lines.push("const skipped = [];");
  // Domain is checked inside every semantic observation, before the next write.
  lines.push(`const expectedHost = ${JSON.stringify(host)};`);

  if (check.expect) lines.push(`let observedDocument;
async function verifyDocument(target) {
  const observed = await browser.read_element({ target });
  if (!observed.documentId) throw new Error("无法确认页面身份，技能未继续执行。");
  if (observedDocument && observedDocument !== observed.documentId) throw new Error("页面在执行中被替换，技能已停止。");
  observedDocument = observed.documentId;
}`);
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

  if (check.expect && marker) {
    lines.push(`const expected = ${JSON.stringify(check.expect)};`);

    if (check.inputKey) lines.push(`expected[${JSON.stringify("contains" in check.expect ? "contains" : "equals")}] = inputs[${JSON.stringify(check.inputKey)}];`);
    lines.push(`const proof = await browser.read_element({ target: await resolveAnchor(${JSON.stringify(marker)}), expect: expected, timeoutMs: 1500 });`);
    lines.push('if (!proof.check?.matched) throw new Error("完成条件未核验，不能报告成功。");');

    if (check.inputKeys?.length) {
      lines.push(`for (const key of ${JSON.stringify(check.inputKeys)}) {`);
      lines.push(`  const result = await browser.read_element({ target: await resolveAnchor(${JSON.stringify(marker)}), expect: { property: "textContent", contains: inputs[key] }, timeoutMs: 1500 });`);
      lines.push('  if (!result.check?.matched) throw new Error("部分材料没有在结果中核对通过。");');
      lines.push('}');
    }

    lines.push(`return { done: true, verified: true, steps: ${steps.length}, ...(skipped.length ? { skipped } : {}) };`);
  } else lines.push(`return { done: true, steps: ${steps.length}, ...(skipped.length ? { skipped } : {}) };`);

  return lines.join("\n");
}

/**
 * Bind the compiler-owned input declaration, not arbitrary JavaScript. This also supports
 * existing saved programs without rewriting their file, version, steps or completion check.
 * A modified/missing declaration fails closed rather than silently using the old values.
 */
export function skillProgramWithInputs(skill: Skill, overrides?: Record<string, string>): string {
  const inputs = bindSkillInputs(skill, overrides);
  const declaration = `const inputs = ${JSON.stringify(skill.inputs, null, 2)};`;
  const parts = skill.program.split(declaration);

  if (parts.length !== 2) throw new Error("技能输入声明已变化，请重新示范；没有执行旧参数。");

  return `${parts[0]}const inputs = ${JSON.stringify(inputs, null, 2)};${parts[1]}`;
}

/**
 * 运行时解析器：按标签 + role + 可访问名匹配；命中且只有一个才打标记，
 * 把"标记选择器"交给原工具。
 *
 * 两端命名规则必须一致（录制在 extension/src/shared/dom-anchor.ts）：
 *   aria-label > 关联 label / aria-labelledby > placeholder > title > 后代图片 alt
 *   > 祖先文字（仅当自己没文字）> 自身文字 > name 属性，
 * 同一套截断（60 字以内，超出补 …）。旧写法只看 aria-label / placeholder /
 * textContent，label-only 的输入框（<label for=city>城市</label> + 无 aria-label）
 * 在第 1 步就"目标找不到"。
 *
 * 语义唯一才执行：0 个命中停，多个同名命中同样停——绝不 find() 选第一个，
 * 那会把"保存"点到错的按钮上。引号纪律：选择器写成不带值的形式
 * （[data-sideagent-target]），页面代码里就不需要转义引号；打标记前先清掉上一次的标记。
 */
const RESOLVER_HELPER = `const semanticKeys = [];
async function locate(anchor) {
  if (!anchor) return { hit: null, reason: "none", count: 0 };
  const semanticKey = JSON.stringify(anchor);
  let semanticIndex = semanticKeys.indexOf(semanticKey);
  if (semanticIndex < 0) semanticIndex = semanticKeys.push(semanticKey) - 1;
  const marker = "skill-" + semanticIndex;
  const source = [
    "(() => {",
    "const host = location.hostname.toLowerCase(); if ((host.startsWith('www.') ? host.slice(4) : host) !== " + JSON.stringify(expectedHost) + ") throw new Error('技能站点已变化，未执行后续操作。');",
    "const spec = " + JSON.stringify(anchor) + ";",
    "const marker = " + JSON.stringify(marker) + ";",
    'const norm = (s) => (s || "").replace(/\\\\s+/g, " ").trim();',
    "const MAX_NAME = 60;",
    "const clip = (s) => { const t = norm(s); if (!t) return \\"\\"; return t.length > MAX_NAME ? t.slice(0, MAX_NAME - 1) + \\"…\\" : t; };",
    "const labelNameOf = (el) => {",
    "  const first = el.labels && el.labels[0] ? el.labels[0].textContent : null;",
    "  if (norm(first)) return first;",
    '  const by = el.getAttribute("aria-labelledby");',
    '  if (!by) return null;',
    '  return by.split(/\\\\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent : ""; }).join(" ");',
    "};",
    "const ancestorNameOf = (el) => {",
    "  if (norm(el.textContent)) return null;",
    "  let cur = el.parentElement;",
    "  for (let depth = 0; depth < 4 && cur; depth += 1) {",
    "    const t = norm(cur.textContent);",
    '    if (t) return t.length > MAX_NAME ? t.slice(0, MAX_NAME - 1) + "…" : t;',
    "    cur = cur.parentElement;",
    "  }",
    "  return null;",
    "};",
    "const namesOf = (el) => {",
    '  const tag = (el.tagName || "").toUpperCase();',
    "  const img = el.querySelector(\\"img[alt], svg[aria-label]\\");",
    "  const raw = [",
    '    el.getAttribute("aria-label"),',
    "    labelNameOf(el),",
    '    el.getAttribute("placeholder"),',
    '    el.getAttribute("title"),',
    '    img ? img.getAttribute("alt") : null,',
    '    img ? img.getAttribute("aria-label") : null,',
    "    ancestorNameOf(el),",
    '    tag === "INPUT" || tag === "SELECT" ? null : el.textContent,',
    '    el.getAttribute("name"),',
    "  ];",
    "  return raw.map(clip).filter(Boolean);",
    "};",
    "const candidates = Array.from(document.querySelectorAll(spec.tag));",
    "const wanted = clip(spec.name);",
    "const matches = candidates.filter((el) => {",
    '  if (spec.role && (el.getAttribute("role") || "").toLowerCase() !== spec.role) return false;',
    "  if (!wanted) return true;",
    "  return namesOf(el)[0] === wanted;",
    "});",
    'if (matches.length !== 1) return { hit: null, reason: matches.length ? "ambiguous" : "none", count: matches.length };',
    "const hit = matches[0];",
    'const selector = "[data-sideagent-target=" + marker + "]";',
    'document.querySelectorAll(selector).forEach((el) => el.removeAttribute("data-sideagent-target"));',
    'hit.setAttribute("data-sideagent-target", marker);',
    'return { hit: selector, reason: null, count: 1 };',
    "})()",
  ].join("\\n");
  const result = await browser.js({ code: source });
  const value = result && result.value;
  return value && typeof value === "object" ? value : { hit: null, reason: "none", count: 0 };
}
async function resolveAnchor(anchor) {
  return (await locate(anchor)).hit;
}
async function resolveStep(index) {
  const found = await locate(resolveSpec[index]);
  if (found && found.hit) return found.hit;
  if (found && found.reason === "ambiguous") throw new Error("第 " + (index + 1) + " 步的目标有 " + found.count + " 个同名对象，不敢乱点：脚本停下。");
  throw new Error("第 " + (index + 1) + " 步的目标在页面上找不到了：脚本停下，没有继续操作。");
}
/** 弱步骤用：认不出来就返回 null，由调用方跳过并记一笔。 */
async function tryResolveStep(index) {
  return (await locate(resolveSpec[index])).hit;
}`;

/** 编译产物必须守住的红线：不出现坐标与 DOM 路径。 */
export function validateCompiledSkill(skill: Skill): string | null {
  if (!validSkillId(skill.id)) return "技能 id 非法";

  if (!skill.hostname) return "技能缺少站点";

  if (skill.steps.length === 0) return "示范里没有可编译的步骤";

  if (skill.check.expect) {
    if (!skill.check.marker?.name) return "技能完成条件缺少具名对象";

    try { validateElementRead({ expect: skill.check.expect }); } catch { return "技能完成条件无效"; }

    if (skill.check.inputKey && !Object.hasOwn(skill.inputs, skill.check.inputKey)) return "技能完成条件引用了未知输入";

    if (skill.check.inputKeys && (!Array.isArray(skill.check.inputKeys) || skill.check.inputKeys.length > 20
      || skill.check.inputKeys.some(key => typeof key !== "string" || !Object.hasOwn(skill.inputs, key)))) return "技能完成条件引用了未知输入";
  }

  const bad = forbiddenInSkill(JSON.stringify({ steps: skill.steps, program: skill.program, check: skill.check }));

  return bad ? `编译产物里出现了${bad}` : null;
}
