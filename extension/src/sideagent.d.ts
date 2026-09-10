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
  fill(target: string, value: string): { filled: true };
  scrollBy(dy: number | null): { atBottom: boolean };
  scrollToBottom(maxSteps?: number): Promise<{ atBottom: boolean }>;
}

interface MarkOptions {
  style?: "rect" | "sketch";
  motion?: "grow" | "boil";
  seed?: number;
}

interface SideAgentCursor {
  /** 绑定这次真实操作与同一个 DOM 元素；id 隔离晚到的结束消息。 */
  beginAction(id: string, kind: "click" | "fill" | "hover", rect?: SideAgentRect, anchor?: Element, label?: string): void;
  endAction(id: string, outcome: "done" | "failed" | "unknown", point?: [number, number]): void;
  /** 状态层：在等 / 在读 / 完成 / 失败挂在光标名牌上。文案在页面侧，调用方只给状态。 */
  setStatus?(view?: { state: "waiting" | "reading" | "done" | "failed"; text?: string; detail?: string; autoHideMs?: number }): void;
  clearStatus?(): void;
  /** 跨页：它在别的标签页干活时，当前页右上角显示可点胶囊（点了切过去） */
  showCrossPage?(view?: { sessionId?: string; title?: string; state?: "waiting" | "reading" | "done" | "failed" }): void;
  hideCrossPage?(): void;
  /** 沿浅弧飞到视口坐标 (x,y)；首次从角落出发。返回飞行毫秒，供调用方等待。 */
  move(x: number, y: number): number;
  /** 执行前确认落点，避免低帧率时视觉仍落后于实际输入。 */
  arrive(x: number, y: number): void;
  /** 在视口坐标 (x,y) 播放点击波纹，随后飞回角落 */
  click(x: number, y: number): void;
  /** 飞回待命角落（不点、不填的时候） */
  park?(): void;
  /** 按文档坐标再飞一遍刚才的点；click 为真时播波纹。不点真页面。可随时 stopReplay。 */
  replay?(points: Array<{ x: number; y: number; click: boolean }>): void;
  stopReplay?(): void;
  hide(): void;
  /** 页顶「现在归你 / 交还」条。接管确认后显示，交还或中止后收掉。 */
  showUserControl?(view?: {
    status?: string;
    sub?: string;
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
    observedNode?: Node,
  ): void;
  /** 拿住目标：飞到 (x,y) 进入持久按住态（不弹回、不 park），名牌变双键；scroll/resize 按 target 锚点跟随 */
  hold?(x: number, y: number, actions: Array<{ id: "confirm" | "cancel"; label: string }>, target?: string): void;
  /** 松开：摘掉按住姿态、名牌恢复成员名，随后照常 park */
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
  cursor?: SideAgentCursor;
  /** overlay 自检：默认光标是否已 hide（生产路径不用） */
  cursorHidden?: () => boolean;
  /** 只读的可视状态自检，不代表页面操作结果。 */
  cursorState?: (id?: string) => {
    action: string | null; phase: string | null; label: string; labelRect: SideAgentRect | null;
    targetRect: SideAgentRect | null; hidden: boolean; resting: boolean; x: number; y: number; size: number;
  } | null;
  /** overlay 自检：当前 mark 的文档坐标盒（生产路径不用） */
  markLayout?: () => Array<{ x: number; y: number; width: number; height: number }>;
  /** overlay 自检：标注层真实子节点数 */
  markLayerCount?: () => number;
  /** overlay 自检：拿住态光标与名牌双键（生产路径不用） */
  holdState?: (instanceId?: string) => {
    holding: boolean;
    pressing: boolean;
    hidden: boolean;
    x: number;
    y: number;
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
  /** overlay 自检：右上角跨页胶囊 */
  crossPageState?: () => {
    main: string;
    sub: string;
    sessionId: string;
    rect: SideAgentRect;
    viewport: { width: number; height: number };
  } | null;
  clickCrossPage?: () => boolean;
  /** overlay 自检：页顶接管条 */
  controlBanner?: () => { status: string; action: string } | null;
  clickHandback?: () => boolean;
  /** 手绘批注配置与动效偏好 */
  setMarkConfig?: (opts: MarkOptions) => void;
  getMarkConfig?: () => MarkOptions;
  markDetails?: () => Array<{
    className: string;
    hasSvg: boolean;
    isGrow: boolean;
    isBoil: boolean;
    isSketch: boolean;
    hasEllipse: boolean;
    hasArrow: boolean;
    boilFrameCount: number;
    labelText: string;
  }>;
}

interface Window {
  __sideagent?: SideAgentNamespace;
}
