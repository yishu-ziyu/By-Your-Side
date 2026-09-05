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
  click(target: string): { clicked: true };
  fill(target: string, value: string): { filled: true };
  scrollBy(dy: number | null): { atBottom: boolean };
  scrollToBottom(maxSteps?: number): Promise<{ atBottom: boolean }>;
}

interface SideAgentCursor {
  /** 沿浅弧飞到视口坐标 (x,y)；首次从角落出发。返回飞行毫秒，供调用方等待。 */
  move(x: number, y: number): number;
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
  /** 在 (rect 视口坐标) 处画持久标注（描边框+箭头+名牌）；target 用于滚动/resize 时按元素重算；actions 为框外确认/取消 */
  mark?(
    rect: SideAgentRect,
    label?: string,
    target?: string,
    actions?: Array<{ id: "confirm" | "cancel"; label: string }>,
  ): void;
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
  /** overlay 自检：当前 mark 的文档坐标盒（生产路径不用） */
  markLayout?: () => Array<{ x: number; y: number; width: number; height: number }>;
  /** overlay 自检：框外确认按钮 */
  markActionLabels?: () => Array<{ id: string; label: string }>;
  clickMarkAction?: (id: string) => boolean;
  /** overlay 自检：页顶接管条 */
  controlBanner?: () => { status: string; action: string } | null;
  clickHandback?: () => boolean;
}

interface Window {
  __sideagent?: SideAgentNamespace;
}
