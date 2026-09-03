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
  /** 平滑移动到视口坐标 (x,y)；从隐藏状态首次出现时直接落位 */
  move(x: number, y: number): void;
  /** 在视口坐标 (x,y) 播放点击波纹 */
  click(x: number, y: number): void;
  hide(): void;
  /** 在目标元素周围绘制呼吸高亮框（透明度脉动，结束后自动销毁） */
  highlight(rect: SideAgentRect): void;
  /** 在 (rect 视口坐标) 处画持久标注（描边框+箭头+名牌），锚定文档坐标随内容滚动 */
  mark?(rect: SideAgentRect, label?: string): void;
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
}

interface Window {
  __sideagent?: SideAgentNamespace;
}
