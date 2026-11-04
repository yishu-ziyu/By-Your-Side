interface SideAgentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SideAgentDomOps {
  resolve(target: string): Element | null;
  rectOf(target: string): SideAgentRect;
  confirmForClick(target: string): SideAgentRect;
  hitTestAt(target: string, x: number, y: number): { hit: true };
  rememberPoint(x: number, y: number): { remembered: true; tag: string };
  confirmPoint(x: number, y: number): { same: true };
  click(target: string): { clicked: true };
  fill(target: string, value: string): { filled: true; range?: import("../../shared/page-readout.js").InputRangeReadout | null } | { refused: string };
  selectOption(
    target: string,
    values: string | { value?: string; label?: string; index?: number } | Array<string | { value?: string; label?: string; index?: number }> | null,
  ): { selected: string[]; labels: string[] };
  scrollBy(dy: number | null): { atBottom: boolean };
  scrollToBottom(maxSteps?: number): Promise<{ atBottom: boolean }>;
}

interface SideAgentEffect {
  begin(input: { token: string; point?: [number, number]; selector?: string }): Promise<{ ok: true }>;
  watch(token: string): { ok: true };
  diff(token: string): import("../../shared/effect.js").EffectReport | null;
  roots(token: string): Array<{ sel: string; field?: true }> | "many" | null;
  quietMs(token: string): number | null;
  end(token: string): { ok: true };
}

interface MarkOptions {
  style?: "rect" | "sketch";
  motion?: "grow" | "boil";
  seed?: number;
}

interface CrossPageMember {
  sessionId: string; title: string; tabId?: number; state?: "waiting" | "reading" | "translating" | "done" | "failed";
}

interface CrossPageView {
  sessionId?: string; title?: string; tabId?: number; state?: CrossPageMember["state"]; members?: CrossPageMember[];
}

interface SideAgentCursor {
  beginAction(id: string, kind: "click" | "fill" | "hover", rect?: SideAgentRect, anchor?: Element, label?: string): void;
  endAction(id: string, outcome: "done" | "failed" | "unknown", point?: [number, number]): void;
  companion?(view: { point: { x: number; y: number } | null; voice: "listening" | "transcribing" | "thinking" | "speaking" | null; fly?: boolean; quiet?: boolean; avoid?: SideAgentRect } | null): void;
  companionLevel?(level: number): void;
  setStatus?(view?: { state: "waiting" | "reading" | "translating" | "done" | "failed"; text?: string; detail?: string; autoHideMs?: number }): void;
  clearStatus?(): void;
  showCrossPage?(view?: CrossPageView): void;
  hideCrossPage?(): void;
  setGlow?(on: boolean): void | Promise<void>;
  showFeedback?(view?: import("./shared/feedback-pill.js").FeedbackPillView): void;
  hideFeedback?(): void;
  expect?(x: number, y: number): void;
  move(x: number, y: number): number;
  gaze?(view: { mode: "at"; rects: SideAgentRect[] } | { mode: "rest" } | { mode: "off" }): void;
  arrive(x: number, y: number): void;
  click(x: number, y: number): void;
  park?(): void;
  replay?(points: Array<{ x: number; y: number; click: boolean }>): void;
  stopReplay?(): void;
  hide(): void;
  leaveTowardPanel?(): Promise<void>;
  returnFromPanel?(): Promise<void>;
  inspect?(rect: SideAgentRect, caption?: string, point?: boolean): void;
  clearInspect?(): Promise<void>;
  showUserControl?(view?: {
    status?: string;
    sub?: string;
    ask?: string;
    action?: string;
    actionEnabled?: boolean;
    members?: Array<{ id: string; initial: string; color: string }>;
  }): void;
  hideUserControl?(): void;
  highlight(rect: SideAgentRect): void;
  mark?(
    rect: SideAgentRect,
    label?: string,
    target?: string,
    actions?: Array<{ id: "confirm" | "cancel"; label: string }>,
    options?: MarkOptions,
    observedNode?: Node | Range,
  ): void;
  guide?(rect: SideAgentRect, say: string, target: string, portName: string, options?: MarkOptions, observedNode?: Node): { name: string };
  handoffMark?(rect: SideAgentRect, target: string, options?: MarkOptions, observedNode?: Node): void;
  handoffLabels?(): void;
  releaseHold?(): void;
  clearMarks?(): void;
  for(instanceId: string): SideAgentCursor;
}

interface SideAgentNamespace {
  refs?: Map<number, Element>;
  snapshot?: (scope?: string) => string;
  dom?: SideAgentDomOps;
  lastDomError?: string;
  effect?: SideAgentEffect;
  cursor?: SideAgentCursor;
  cursorBodies?: () => number;
  companionState?: () => {
    phase: "listening" | "transcribing" | "thinking" | "answering" | "speaking" | "idle" | null;
    pointer: { x: number; y: number; shown: boolean } | null;
    target: { text: string; rect: SideAgentRect; inView: boolean } | null;
  };
  cursorHidden?: () => boolean;
  cursorState?: (id?: string) => {
    action: string | null; phase: string | null; label: string; labelRect: SideAgentRect | null;
    targetRect: SideAgentRect | null; hidden: boolean; resting: boolean; x: number; y: number; size: number;
  } | null;
  markLayout?: () => Array<{ x: number; y: number; width: number; height: number; stroke: SideAgentRect | null; label: SideAgentRect | null }>;
  markLayerCount?: () => number;
  marksState?: () => import("../../shared/host-marks.js").HostDrawnMark[];
  handoffState?: () => Array<{ kind: "field" | "button"; name: string; label: string; labelRect: SideAgentRect | null; faded: boolean; shown: boolean }>;
  inspectState?: () => { shown: boolean; caption: string; x: number; y: number; width: number; height: number } | null;
  holdState?: (instanceId?: string) => {
    holding: boolean;
    pressing: boolean;
    hidden: boolean;
    x: number;
    y: number;
    guide: { label: string; misses: number; parkedAtTarget: boolean; checking: boolean } | null;
  } | null;
  holdActionLabels?: () => Array<{ id: string; label: string }>;
  clickHoldAction?: (id: string) => boolean;
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
  edgeTab?: () => import("./content/edge-tab.js").EdgeTabState | null;
  clickEdgeTab?: (part: "capsule" | "stop" | "action" | "bubble" | number) => boolean;
  uncoverPageTarget?: (target: Element, x: number, y: number, token: string) => boolean;
  restorePageTarget?: (token: string) => void;
  floatCard?: { uncover(target: Element, x: number, y: number, token: string): boolean; restore(token: string): void };
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

declare module "pdfjs-dist/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
