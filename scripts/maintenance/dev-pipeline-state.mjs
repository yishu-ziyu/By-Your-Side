import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile, open, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const digest = value => createHash("sha256").update(value).digest("hex");
export const object = value => !!value && typeof value === "object" && !Array.isArray(value);
export const slug = value => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,70}$/.test(value);
export const commit = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export const text = value => typeof value === "string" && value.trim().length > 0 && value.length <= 6000;

export function within(root, path) {
  const rel = relative(resolve(root), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("路径超出工作目录");
  return resolve(path);
}

export async function json(file) {
  const raw = await readFile(file, "utf8");
  if (raw.length > 2_000_000) throw new Error("状态文件过大");
  return JSON.parse(raw);
}

const writes = new Map();
export async function save(file, value) {
  const next = (writes.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, file);
  });
  writes.set(file, next);
  try { await next; } finally { if (writes.get(file) === next) writes.delete(file); }
}

export async function lock(file, action) {
  let handle;
  try { handle = await open(file, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`已有任务占用锁；先确认旧进程已退出，保留现场：${file}`);
    throw error;
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); return await action(); }
  finally { await handle.close(); await unlink(file); }
}

const strings = { type: "array", items: { type: "string" } };
const taskProperties = {
  id: { type: "string" }, title: { type: "string" }, goal: { type: "string" },
  kind: { type: "string", enum: ["bug", "chore", "feature"] },
  sourceIds: strings, files: strings, cases: strings, dependsOn: strings, acceptance: strings,
  needsDecision: { type: "boolean" }, decision: { type: "string" },
};
export const planSchema = {
  type: "object", additionalProperties: false,
  properties: { summary: { type: "string" }, tasks: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, properties: taskProperties, required: Object.keys(taskProperties) } } },
  required: ["summary", "tasks"],
};
export const workerSchema = {
  type: "object", additionalProperties: false,
  properties: { summary: { type: "string" }, changed: { type: "boolean" }, limitations: strings },
  required: ["summary", "changed", "limitations"],
};
export const reviewSchema = {
  type: "object", additionalProperties: false,
  properties: { approved: { type: "boolean" }, findings: strings, summary: { type: "string" } },
  required: ["approved", "findings", "summary"],
};

export function validatePlan(plan, snapshot) {
  if (!object(plan) || !text(plan.summary) || !Array.isArray(plan.tasks) || plan.tasks.length > 3) throw new Error("拆解结果无效");
  const sources = new Set(snapshot.sources.map(source => source.id));
  const cases = new Set(snapshot.cases);
  const ids = new Set();
  for (const task of plan.tasks) {
    if (!object(task) || !slug(task.id) || ids.has(task.id) || !text(task.title) || !text(task.goal)) throw new Error("任务标识或目标无效");
    for (const field of ["sourceIds", "files", "cases", "dependsOn", "acceptance"]) {
      if (!Array.isArray(task[field]) || task[field].some(value => !text(value)) || new Set(task[field]).size !== task[field].length) throw new Error(`任务 ${task.id} 的 ${field} 无效`);
    }
    if (!task.sourceIds.length || task.sourceIds.some(id => !sources.has(id))) throw new Error("任务缺少真实来源");
    if (!task.files.length || task.files.length > 12 || task.files.some(file => isAbsolute(file) || file.split(/[\\/]/).some((part, index) => !part || part === "." || part === ".." || part.startsWith(".") && !(index === 0 && part === ".github")) || /[\\*?\0\r\n]/.test(file))) throw new Error("改动文件范围无效；使用明确的仓库相对文件名");
    if (!task.acceptance.length || task.cases.some(name => !cases.has(name))) throw new Error("验收标准或用例不存在");
    if (task.files.some(file => /^(extension\/src|agent\/src|shared)\//.test(file)) && !task.cases.length) throw new Error("产品改动必须指定相关真实路径用例");
    if (task.dependsOn.length > 1 || task.dependsOn.some(id => !ids.has(id))) throw new Error("依赖必须指向前面的单个任务");
    if (!["bug", "chore", "feature"].includes(task.kind) || typeof task.needsDecision !== "boolean" || typeof task.decision !== "string") throw new Error("任务类型或决策状态无效");
    if (task.kind === "feature" || task.sourceIds.some(id => !snapshot.sources.find(source => source.id === id)?.trusted)) {
      task.needsDecision = true;
      task.decision ||= "新能力或外部来源需要用户确认范围";
    }
    if (task.sourceIds.some(id => snapshot.sources.find(source => source.id === id)?.claimed)) throw new Error("来源已有执行任务或未合并 PR");
    for (const prior of plan.tasks.filter(prior => ids.has(prior.id))) {
      if (task.files.some(file => prior.files.includes(file)) && !task.dependsOn.includes(prior.id)) throw new Error("并行任务不能修改同一文件");
    }
    ids.add(task.id);
  }
  return plan;
}

export async function directory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}
