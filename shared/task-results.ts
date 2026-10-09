import { taskId } from "./task-actions.js";
import {isWriteTool} from './control.js';
import {classifyToolEffect} from './effect-policy.js';

export const TASK_RESULT_STATES = ["unregistered", "pending", "satisfied", "blocked", "unknown"] as const;

export type TaskResultState = (typeof TASK_RESULT_STATES)[number];

export const TASK_RESULT_ITEM_STATUSES = ["pending", "satisfied", "blocked", "unknown"] as const;

export type TaskResultItemStatus = (typeof TASK_RESULT_ITEM_STATUSES)[number];

/** Intent-only registration. Status/completion cannot be declared here. */
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
  /** 这条回执开始或结束的时刻。旧快照可缺省。 */
  observedAt?: number;
  /** Host-classified effects for aliases or parameter-dependent tools (tabs/fetch). */
  effectful?: true;
  /** 旧版本存档字段（2026-10-04 起不再产生，也不再使用）：只为旧任务记录仍能读入。 */
  awaitingConfirmation?: true;
}

export interface TaskResultItem extends TaskResultRegistration {
  status: TaskResultItemStatus;
  evidence: TaskResultEvidence | null;
  /** 该未知项已被后续更可信的状态项取代；旧证据保留，不再算作未完成。 */
  supersededBy?: string;
}

/** Focus, scrolling and hovering require control, but do not create durable write obligations. */
export function resultToolHasWriteEffect(tool:string):boolean {
  return isWriteTool(tool)&&!['switch_tab','scroll','hover','ask_user_to_point'].includes(tool);
}

/** 这一步改过页面（或可能改过）：用于读回、目标失效等「页面变了」的判断，不决定结果不确定时拦什么。 */
export function resultHasWriteEffect(item:Pick<TaskResultItem,'tool'|'evidence'>):boolean {
  return resultToolHasWriteEffect(item.tool)||item.evidence?.effectful===true;
}

/**
 * 写类工具里，出错或超时也不会留下业务后果的：看页辅助（滚动、悬停、圈画、点选）、
 * 换页（导航、开/切/关标签页、页面归属）、等页面事件、处理原生弹窗、松开按住的输入。
 */
const NO_REPEAT_HARM_WRITES: ReadonlySet<string> = new Set([
  'worker_tabs', 'navigate', 'open_tab', 'switch_tab', 'close_tab',
  'scroll', 'hover', 'mark', 'clear_marks', 'ask_user_to_point',
  'arm_event', 'wait_event', 'disarm_event', 'accept_dialog', 'dismiss_dialog',
  'release_held_inputs',
]);

/**
 * 这一步出错或超时时，后果可能已经发生（提交、付款、发送、删除、确认原生弹窗……）。
 * 按现有副作用分类：控制闸门的写类工具去掉上面那组，再加上确认弹窗与 POST/带 body 的 fetch。
 */
export function commitsHarm(name:string, params?:Parameters<typeof classifyToolEffect>[1]):boolean {
  if (name === 'fetch') return classifyToolEffect(name, params).class === 'write';

  return name === 'accept_dialog' || isWriteTool(name) && !NO_REPEAT_HARM_WRITES.has(name);
}

/**
 * 账本项出错或超时时记成「结果未知」，而不是「失败」。这只是如实记账：不暂停写入，也不拦重做（10-10 用户裁决）。
 * fetch 的副作用按参数判定：宿主把 POST/带 body 的 fetch 记在 evidence.effectful。
 */
export function resultLocksWhenUnknown(item:{tool:string;evidence?:{effectful?:boolean}|null}):boolean {
  return commitsHarm(item.tool)||item.tool==='fetch'&&item.evidence?.effectful===true;
}

export const TASK_RESULT_META_TOOLS = ["capture_page_material", "task_goals", "record_task_results", "send_user_message"] as const;

/** 算作页面读回的真实只读工具。read_elements 是宿主按选择器的有界多元素读回，与 read_element 同级。 */
export const RESULT_VERIFY_READ_TOOLS = ["read_element", "read_elements", "snapshot"] as const;

/** 单条读数的完整文本上限；超过即标记截断。 */
export const RESULT_OBSERVATION_TEXT_MAX = 50_000;

const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length >= 1 && v.length <= max;

/** Opaque correlation data, not a task/file key. Preserve program suffixes and provider ids exactly. */
export function isToolCallId(value: unknown): value is string {
  return text(value, 512) && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export function isTaskResultEvidence(v: unknown): v is TaskResultEvidence {
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
    && (r.supersededBy === undefined || typeof r.supersededBy === 'string' && taskId(r.supersededBy));
}

/** 只有取代项本身已满足时，被取代的未知才不再阻塞；否则未知仍生效。 */
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

// ── 执行事实到账本项的绑定（记账下沉） ────────────────────────────────

/** 自动登记项的 id 前缀；模型之后用 record_task_results 声明同一目标时应吸收它，而不是新增一条待办。 */
export const AUTO_RESULT_ID_PREFIX = "auto-";

/** 账本项上限；自动登记达到上限后不再新增，但已登记项的绑定与回执照常。 */
export const MAX_TASK_RESULTS = 64;

export type ResultBinding =
  /** 已有同工具同目标、尚无证据（或上次失败、结果未知）的待办项：直接绑定。 */
  | { kind: "exact"; itemId: string }
  /** 登记了意图但还没定位的同工具待办项（target=null，且尚无证据）：可把实际目标改绑到它。 */
  | { kind: "rebind"; itemId: string }
  /** 没有可复用的待办：调用方决定是否按真实动作新建自动项。 */
  | { kind: "create" }
  /** 同工具同目标已有在途的项：不新建、不改绑。 */
  | { kind: "none" };

/**
 * 从真实工具调用派生账本绑定（纯函数）。
 * 只复用「尚无证据的 pending」、「上次失败的 blocked」与「结果未知的 unknown」项：重做同一步时，
 * 新回执落在原项上。satisfied 是历史回执，不参与改绑。已写明 target 的登记项不静默漂移：
 * 实际目标不同时新建自动项，原登记保持待办。歧义（多个未定位待办）不猜，交给调用方新建。
 */
export function selectResultBinding(items: readonly TaskResultItem[], tool: string, target: string | null): ResultBinding {
  if (isResultMetaTool(tool)) return { kind: "none" };

  const retry = (item: TaskResultItem) => item.status === "blocked" || item.status === "unknown";
  const exact = items.find(item => (!item.evidence || retry(item))
    && resultCanUseExecution(retry(item) ? { ...item, status: "pending" } : item, tool, target));

  if (exact) return { kind: "exact", itemId: exact.id };

  // A completed receipt describes one invocation, not every later call at that
  // target. The execution gate owns replay permission; an allowed new call must
  // get its own receipt so audit coverage does not silently become incomplete.
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

/**
 * 自动账本项的人话说明：模型没登记时用它填回执。只从调用参数与目标派生，
 * 不读页面、不加推测；信息不足时回退到动作名。
 */
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
