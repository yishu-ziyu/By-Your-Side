import { taskId } from "./task-actions.js";
import { isWriteTool } from './effect-policy.js';
import {classifyToolEffect} from './effect-policy.js';

export const TASK_RESULT_STATES = ["unregistered", "pending", "satisfied", "blocked", "unknown"] as const;

export type TaskResultState = (typeof TASK_RESULT_STATES)[number];

export const TASK_RESULT_ITEM_STATUSES = ["pending", "satisfied", "blocked", "unknown"] as const;

export type TaskResultItemStatus = (typeof TASK_RESULT_ITEM_STATUSES)[number];

export interface TaskResultRegistration {
  id: string;
  description: string;
  tool: string;
  target: string | null;
}

export interface TaskResultEvidence {
  toolCallId: string;
  tool: string;
  target: string | null;
  member: string;
  runId: string;
  observedAt?: number;
  effectful?: true;
  awaitingConfirmation?: true;
}

export interface TaskResultItem extends TaskResultRegistration {
  status: TaskResultItemStatus;
  evidence: TaskResultEvidence | null;
  reason?: string;
  supersededBy?: string;
}

export function resultToolHasWriteEffect(tool:string):boolean {
  return isWriteTool(tool)&&!['switch_tab','scroll','hover','ask_user_to_point'].includes(tool);
}

export function resultHasWriteEffect(item:Pick<TaskResultItem,'tool'|'evidence'>):boolean {
  return resultToolHasWriteEffect(item.tool)||item.evidence?.effectful===true;
}

const NO_REPEAT_HARM_WRITES: ReadonlySet<string> = new Set([
  'worker_tabs', 'navigate', 'open_tab', 'switch_tab', 'close_tab',
  'scroll', 'hover', 'mark', 'clear_marks', 'ask_user_to_point',
  'arm_event', 'wait_event', 'disarm_event', 'accept_dialog', 'dismiss_dialog',
  'release_held_inputs',
]);

function commitsHarm(name:string, params?:Parameters<typeof classifyToolEffect>[1]):boolean {
  if (name === 'fetch') return classifyToolEffect(name, params).class === 'write';

  return name === 'accept_dialog' || isWriteTool(name) && !NO_REPEAT_HARM_WRITES.has(name);
}

export function resultLocksWhenUnknown(item:{tool:string;evidence?:{effectful?:boolean}|null}):boolean {
  return commitsHarm(item.tool)||item.tool==='fetch'&&item.evidence?.effectful===true;
}

const FILL_RESULT_TOOLS = new Set(["fill", "type_text", "page_operation", "select_option"]);

const SUBMIT_HINT = /提交|发送|submit|send/i;

export function endingFromResults(
  results: ReadonlyArray<Pick<TaskResultItem, "tool" | "status" | "target" | "description" | "evidence">>,
  outcome: "complete" | "partial" | "stopped" | "error",
): string {
  const fills = results.filter((item) => FILL_RESULT_TOOLS.has(item.tool) && item.status === "satisfied");
  const submitted = results.some((item) => item.status === "satisfied" && (
    (item.tool === "click" && SUBMIT_HINT.test(`${item.target ?? ""} ${item.description}`))
    || item.tool === "fetch" && item.evidence?.effectful === true
  ));

  if (fills.length) return submitted ? `填好 ${fills.length} 栏并提交了` : `填好 ${fills.length} 栏，没提交`;
  if (outcome === "stopped") return "你中止了任务";
  if (outcome === "error") return "上次出错";
  if (outcome === "partial") return "上次没做完";
  if (outcome === "complete") return "做完了";

  return "";
}

const TASK_RESULT_META_TOOLS = ["capture_page_material", "task_goals", "record_task_results", "send_user_message"] as const;

export const RESULT_VERIFY_READ_TOOLS = ["read_element", "read_elements", "snapshot"] as const;

export const RESULT_OBSERVATION_TEXT_MAX = 50_000;

const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length >= 1 && v.length <= max;

function isToolCallId(value: unknown): value is string {
  return text(value, 512) && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isTaskResultEvidence(v: unknown): v is TaskResultEvidence {
  if (!v || typeof v !== "object") return false;
  const e = v as TaskResultEvidence;

  return isToolCallId(e.toolCallId) && text(e.tool, 100) && text(e.member, 128) && taskId(e.runId)
    && (e.target === null || text(e.target, 500))
    && (e.observedAt === undefined || Number.isFinite(e.observedAt))
    && (e.effectful === undefined || e.effectful === true)
    && (e.awaitingConfirmation === undefined || e.awaitingConfirmation === true);
}

export function isTaskResultItem(v: unknown): v is TaskResultItem {
  if (!v || typeof v !== "object") return false;
  const r = v as TaskResultItem;

  return taskId(r.id) && text(r.description, 600) && text(r.tool, 100)
    && (r.target === null || text(r.target, 500))
    && TASK_RESULT_ITEM_STATUSES.includes(r.status)
    && (r.evidence === null || isTaskResultEvidence(r.evidence))
    && (r.reason === undefined || text(r.reason, 100))
    && (r.supersededBy === undefined || typeof r.supersededBy === 'string' && taskId(r.supersededBy));
}

export function withoutFailureReasons(items: readonly TaskResultItem[]): TaskResultItem[] {
  return items.map(({ reason: _reason, ...item }) => item);
}

export function isSupersededUnknown(item: Pick<TaskResultItem,'id'|'status'|'supersededBy'>, items: readonly TaskResultItem[]): boolean {
  return item.status === 'unknown' && typeof item.supersededBy === 'string'
    && items.some(candidate => candidate.id === item.supersededBy && candidate.status === 'satisfied');
}

export function isTaskResultState(v: unknown): v is TaskResultState {
  return typeof v === "string" && (TASK_RESULT_STATES as readonly string[]).includes(v);
}

export function resultStateOf(items: readonly TaskResultItem[]): TaskResultState {
  if (items.length === 0) return "unregistered";

  if (items.some(item => item.status === "unknown" && !isSupersededUnknown(item, items))) return "unknown";

  if (items.some(item => item.status === "blocked")) return "blocked";

  if (items.some(item => item.status === "pending")) return "pending";

  return "satisfied";
}

export function isResultMetaTool(name: string): boolean {
  return (TASK_RESULT_META_TOOLS as readonly string[]).includes(name);
}

export function normalizeTaskResultRegistration(v: unknown): TaskResultRegistration | null {
  if (!v || typeof v !== "object") return null;
  const r = v as TaskResultRegistration;

  if (!taskId(r.id) || !text(r.description, 600) || !text(r.tool, 100) || isResultMetaTool(r.tool)) return null;
  const rawTarget = r.target == null || r.target === 'null' || r.target === '' ? null : r.target;

  if (!(rawTarget === null || text(rawTarget, 500))) return null;

  return { id: r.id, description: r.description.trim(), tool: r.tool, target: typeof rawTarget === "string" ? normalizeResultTarget(rawTarget) : null };
}

export function normalizeResultTarget(target: string): string {
  const clean = target.trim();

  return clean.startsWith('loc=css:') ? clean.slice('loc=css:'.length).trim() : clean;
}

export function extractResultTarget(params: Record<string, unknown> | undefined, tool?: string): string | null {
  if ((tool === 'switch_tab' || tool === 'tabs' && params?.action === 'switch') && Number.isSafeInteger(params?.tabId)) return `tab:${params!.tabId}`;
  const target = params?.target;

  return typeof target === "string" && target.trim() ? normalizeResultTarget(target) : null;
}

export function resultCanUseExecution(item: Pick<TaskResultItem, "tool" | "target" | "status">, tool: string, target: string | null): boolean {
  if (item.status !== "pending" || item.tool !== tool || isResultMetaTool(tool)) return false;

  return item.target === target;
}

export const AUTO_RESULT_ID_PREFIX = "auto-";

export const MAX_TASK_RESULTS = 64;

type ResultBinding =
  | { kind: "exact"; itemId: string }
  | { kind: "rebind"; itemId: string }
  | { kind: "create" }
  | { kind: "none" };

export function selectResultBinding(items: readonly TaskResultItem[], tool: string, target: string | null, description?: string): ResultBinding {
  if (isResultMetaTool(tool)) return { kind: "none" };

  const retry = (item: TaskResultItem) => item.status === "blocked" || item.status === "unknown";
  const exact = items.find(item => (!item.evidence || retry(item))
    && resultCanUseExecution(retry(item) ? { ...item, status: "pending" } : item, tool, target));

  if (exact) return { kind: "exact", itemId: exact.id };

  const retried = description ? items.find(item => item.status === "blocked" && item.id.startsWith(AUTO_RESULT_ID_PREFIX) && item.tool === tool && item.description === description) : undefined;

  if (retried) return { kind: "rebind", itemId: retried.id };

  if (items.some(item => item.tool === tool && item.target === target && item.status !== 'satisfied')) return { kind: "none" };
  const unlocated = items.filter(item => item.status === "pending" && item.evidence === null && item.tool === tool && item.target === null);

  if (unlocated.length === 1) return { kind: "rebind", itemId: unlocated[0]!.id };

  return { kind: "create" };
}

const RESULT_ACTION_LABELS: Record<string, string> = {
  click: "点击", double_click: "双击", drag: "拖动", upload_file: "上传文件", cdp: "CDP 调用", hover: "悬停", fill: "填写", page_operation: "修改字段", page_translation: "翻译网页", type_text: "输入文字",
  press_key: "按键", wheel: "滚轮", mouse_down: "按下鼠标", mouse_up: "松开鼠标", key_down: "按下键", key_up: "松开键",
  release_held_inputs: "松开按住输入", paste: "粘贴", html5_drag: "HTML5 拖放", select_option: "选择选项",
  navigate: "打开页面", open_tab: "打开标签页", switch_tab: "切换标签页",
  close_tab: "关闭标签页", scroll: "滚动页面", mark: "标注页面", clear_marks: "清除标注",
  js: "执行页面脚本", worker_tabs: "调整页面归属", share_tab: "设置协作页面",
};

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().replace(/\s+/g, " ");

  if (!clean) return null;

  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function deriveResultDescription(name: string, params: Record<string, unknown> | undefined, target: string | null): string {
  const p = params ?? {};
  const tabTool = name === 'tabs' && ['open', 'switch', 'close'].includes(String(p.action)) ? `${p.action}_tab` : name;
  const action = RESULT_ACTION_LABELS[tabTool] ?? name;
  const label = shortText(p.label, 40);
  const url = shortText(p.url, 80);
  const key = shortText(p.key, 20);
  let text: string;

  switch (name) {
    case 'tabs':
      text = action;
      break;
    case "click":
    case "double_click":
    case "drag":
    case "hover":
    case "mark":
      if (name === "mark" && Array.isArray(p.text) && p.text.length) { text = `${action}「${shortText(p.text.join("、"), 40)}」`; break; }
      text = label ? `${action}「${label}」` : shortText(target, 120) ? `${action} ${shortText(target, 120)}` : action;
      break;
    case "navigate":
    case "open_tab":
      text = url ? `${action} ${url}` : action;
      break;
    case "press_key":
      text = key ? `${action} ${key}` : action;
      break;
    default:
      text = shortText(target, 120) ? `${action} ${shortText(target, 120)}` : action;
      break;
  }

  return text.length > 600 ? text.slice(0, 599) : text;
}
