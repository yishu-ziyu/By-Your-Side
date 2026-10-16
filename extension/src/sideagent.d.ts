/**
 * 页面侧（content scripts 注入后）window.__sideagent 的形状。
 * background 通过 chrome.scripting.executeScript 的 func 调用这些入口；
 * 该声明同时供 content scripts 自身实现时引用。
 */
interface SideAgentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SideAgentDomOps {
  /** 解析 target 定位串，失败（如 ref 失效）返回 null */
  resolve(target: string): Element | null;
  /** 解析并滚动到可见，返回视口坐标系下的包围盒；失败抛一行信息的 Error */
  rectOf(target: string): SideAgentRect;
  /** 点击前确认目标仍连接、可见、未被其他元素挡住；返回当前包围盒 */
  confirmForClick(target: string): SideAgentRect;
  /** 在指定视口坐标确认仍命中同一目标；不滚动 */
  hitTestAt(target: string, x: number, y: number): { hit: true };
  /** 纯坐标：记录点下当前对象，供按下前核对是否被替换 */
  rememberPoint(x: number, y: number): { remembered: true; tag: string };
  /** 纯坐标：按下前确认仍是记住的同一节点（canvas 只认元素身份，不认画布内部） */
  confirmPoint(x: number, y: number): { same: true };
  click(target: string): { clicked: true };
  fill(target: string, value: string): { filled: true; range?: import("../../shared/page-readout.js").InputRangeReadout | null } | { refused: string };
  /** CAP-02C：value/label/index、多选、清空；返回最终选中集合。 */
  selectOption(
    target: string,
    values: string | { value?: string; label?: string; index?: number } | Array<string | { value?: string; label?: string; index?: number }> | null,
  ): { selected: string[]; labels: string[] };
  scrollBy(dy: number | null): { atBottom: boolean };
  scrollToBottom(maxSteps?: number): Promise<{ atBottom: boolean }>;
}

interface SideAgentEffect {
  /** 取基线（含 60ms 页面活跃度采样）；token 由调用方生成 */
  begin(input: { token: string; point?: [number, number]; selector?: string }): Promise<{ ok: true }>;
  /** 只记动作期间哪里变了（不取基线、不能 diff） */
  watch(token: string): { ok: true };
  /** 与基线比对；会话不存在（换文档/过期）返回 null */
  diff(token: string): import("../../shared/effect.js").EffectReport | null;
  /** 动作期间变过的几处（定位串）；太多返回 "many"，会话不存在返回 null */
  roots(token: string): Array<{ sel: string; field?: true }> | "many" | null;
  /** 会话里最后一次变化离现在多久（毫秒）；还没变过返回 null */
  quietMs(token: string): number | null;
  end(token: string): { ok: true };
}

interface MarkOptions {
  style?: "rect" | "sketch";
  motion?: "grow" | "boil";
  seed?: number;
}

interface CrossPageMember {
  sessionId: string; title: string; tabId?: number; state?: "waiting" | "reading" | "done" | "failed";
}

interface CrossPageView {
  sessionId?: string; title?: string; tabId?: number; state?: CrossPageMember["state"]; members?: CrossPageMember[];
}

interface SideAgentCursor {
  /** 绑定这次真实操作与同一个 DOM 元素；id 隔离晚到的结束消息。 */
  beginAction(id: string, kind: "click" | "fill" | "hover", rect?: SideAgentRect, anchor?: Element, label?: string): void;
  endAction(id: string, outcome: "done" | "failed" | "unknown", point?: [number, number]): void;
  /** 状态层：在等 / 在读 / 完成 / 失败，画在右边缘胶囊上。文案在页面侧，调用方只给状态。 */
  setStatus?(view?: { state: "waiting" | "reading" | "done" | "failed"; text?: string; detail?: string; autoHideMs?: number }): void;
  clearStatus?(): void;
  /** 跨页：它在别的标签页干活时，当前页右边缘胶囊指向那一页（点了切过去） */
  showCrossPage?(view?: CrossPageView): void;
  hideCrossPage?(): void;
  /** 页面边缘光：这个成员正在操作本页时亮，结束时灭。 */
  setGlow?(on: boolean): void | Promise<void>;
  /** 执行反馈：宿主事实短语，画在右边缘胶囊上；不抢焦点、不配音、不循环。 */
  showFeedback?(view?: import("./shared/feedback-pill.js").FeedbackPillView): void;
  hideFeedback?(): void;
  /** 登记助手即将派发鼠标事件的落点（光标不飞过去时），页面光效不把它当成用户。 */
  expect?(x: number, y: number): void;
  /** 沿浅弧飞到视口坐标 (x,y)；首次从角落出发。返回飞行毫秒，供调用方等待。 */
  move(x: number, y: number): number;
  /** 注视区：它读页面时看着哪。sweep 整页读；at 读到的具体元素；rest 读完变淡待命；off 收起。 */
  gaze?(view: { mode: "sweep" } | { mode: "at"; rects: SideAgentRect[] } | { mode: "rest" } | { mode: "off" }): void;
  /** 执行前确认落点，避免低帧率时视觉仍落后于实际输入。 */
  arrive(x: number, y: number): void;
  /** 在视口坐标 (x,y) 播放点击波纹，随后停在原处 */
  click(x: number, y: number): void;
  /** 飞回待命角落（不点、不填的时候） */
  park?(): void;
  /** 按文档坐标再飞一遍刚才的点；click 为真时播波纹。不点真页面。可随时 stopReplay。 */
  replay?(points: Array<{ x: number; y: number; click: boolean }>): void;
  stopReplay?(): void;
  hide(): void;
  /** 接管：朝侧栏方向退场，等动画结束后再 hide。 */
  leaveTowardPanel?(): Promise<void>;
  /** 交还：重读完成后从侧栏边回到待命位置。 */
  returnFromPanel?(): Promise<void>;
  /** 步骤对照：持久描边，不自动消失。 */
  inspect?(rect: SideAgentRect, caption?: string, point?: boolean): void;
  clearInspect?(): Promise<void>;
  /** 「现在归你」：占右边缘胶囊，带继续键。接管确认后显示，交还或中止后收掉。 */
  showUserControl?(view?: {
    status?: string;
    sub?: string;
    ask?: string;
    action?: string;
    actionEnabled?: boolean;
    members?: Array<{ id: string; initial: string; color: string }>;
  }): void;
  hideUserControl?(): void;
  /** 在目标元素周围绘制呼吸高亮框（透明度脉动，结束后自动销毁） */
  highlight(rect: SideAgentRect): void;
  /** 在 (rect 视口坐标) 处画持久标注（描边框+箭头+名牌）；target 用于滚动/resize 时按元素重算；带 actions 时光标飞到目标拿住，确认/取消双键长在光标名牌上 */
  mark?(
    rect: SideAgentRect,
    label?: string,
    target?: string,
    actions?: Array<{ id: "confirm" | "cancel"; label: string }>,
    options?: MarkOptions,
    observedNode?: Node | Range,
  ): void;
  /** 教学一步：圈出目标、名牌写 say、光标停在目标右下角，连上后台的 portName 报告用户的点击。返回目标的可见名字。 */
  guide?(rect: SideAgentRect, say: string, target: string, portName: string, options?: MarkOptions, observedNode?: Node): { name: string };
  /** 交给用户时圈出一个要用户填的栏或点的按钮（橙色）；页面不归用户时不画。填好、点过就淡出，「现在归你」收起时清掉。 */
  handoffMark?(rect: SideAgentRect, target: string, options?: MarkOptions, observedNode?: Node): void;
  /** 圈都画好后摆名牌：第一个还空着的栏写「你来填 · …」，按钮写「填完点这里」或「点这里」。 */
  handoffLabels?(): void;
  /** 松开：摘掉按住姿态、名牌恢复成员名，光标停在原处 */
  releaseHold?(): void;
  /** 清除全部 mark 标注 */
  clearMarks?(): void;
  /** 取某个 Agent 实例的专属光标（调色板着色，名牌为 id），供并行任务区分 */
  for(instanceId: string): SideAgentCursor;
}

interface SideAgentNamespace {
  refs?: Map<number, Element>;
  snapshot?: (scope?: string) => string;
  dom?: SideAgentDomOps;
  /** 动作效果证据（按需注入 content-effect.js 后可用） */
  effect?: SideAgentEffect;
  cursor?: SideAgentCursor;
  /** overlay 自检：默认光标是否已 hide（生产路径不用） */
  cursorHidden?: () => boolean;
  /** 只读的可视状态自检，不代表页面操作结果。 */
  cursorState?: (id?: string) => {
    action: string | null; phase: string | null; label: string; labelRect: SideAgentRect | null;
    targetRect: SideAgentRect | null; hidden: boolean; resting: boolean; x: number; y: number; size: number;
  } | null;
  /** overlay 自检：当前 mark 的文档坐标盒（生产路径不用） */
  markLayout?: () => Array<{ x: number; y: number; width: number; height: number; stroke: SideAgentRect | null; label: SideAgentRect | null }>;
  /** overlay 自检：标注层真实子节点数 */
  markLayerCount?: () => number;
  /** 宿主自画标注的只读读数，供核验「圈给用户看」；页面脚本读不到。 */
  marksState?: () => import("../../shared/host-marks.js").HostDrawnMark[];
  /** 交给用户时画的圈的只读读数，供验收核对；页面脚本读不到。 */
  handoffState?: () => Array<{ kind: "field" | "button"; name: string; label: string; labelRect: SideAgentRect | null; faded: boolean; shown: boolean }>;
  inspectState?: () => { shown: boolean; caption: string; x: number; y: number; width: number; height: number } | null;
  /** overlay 自检：拿住态光标与名牌双键（生产路径不用） */
  holdState?: (instanceId?: string) => {
    holding: boolean;
    pressing: boolean;
    hidden: boolean;
    x: number;
    y: number;
    /** 这个光标正在教一步：圈旁的说明、点错次数、光标是否停在目标旁、是否正在看点中后的页面变化。 */
    guide: { label: string; misses: number; parkedAtTarget: boolean; checking: boolean } | null;
  } | null;
  holdActionLabels?: () => Array<{ id: string; label: string }>;
  clickHoldAction?: (id: string) => boolean;
  /** overlay 自检：光标状态名牌（状态层） */
  cursorStatus?: (id?: string) => {
    state: string | null;
    text: string;
    detail: string;
    fontSize: string;
    nameFontSize: string;
    borderColor: string;
    opacity: number;
    labelRect: SideAgentRect | null;
    x: number;
    y: number;
    hidden: boolean;
    resting: boolean;
  } | null;
  /** 验收读数：右边缘胶囊此刻显示什么（只读）。 */
  edgeTab?: () => import("./content/edge-tab.js").EdgeTabState | null;
  /** 验收：按部位点胶囊，和真人点走同一个处理函数。 */
  clickEdgeTab?: (part: "capsule" | "stop" | "action" | "bubble" | number) => boolean;
  uncoverPageTarget?: (target: Element, x: number, y: number, token: string) => boolean;
  restorePageTarget?: (token: string) => void;
  /** 手绘批注配置与动效偏好 */
  setMarkConfig?: (opts: MarkOptions) => void;
  getMarkConfig?: () => MarkOptions;
  markDetails?: () => Array<{
    className: string;
    hasSvg: boolean;
    isGrow: boolean;
    isBoil: boolean;
    isSketch: boolean;
    hasFrame: boolean;
    boilFrameCount: number;
    labelText: string;
  }>;
}

interface Window {
  __sideagent?: SideAgentNamespace;
}

/** pdf.js 的工作线程模块不带类型；本扩展只把它整个交给 pdf.js 在本线程里跑。 */
declare module "pdfjs-dist/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
