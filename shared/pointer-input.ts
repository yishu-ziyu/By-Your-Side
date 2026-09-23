/**
 * CAP-02B：指针/按键/粘贴参数形状与纯函数。
 * 只放类型与可单测的纯逻辑；执行（CDP / 剪贴板宿主）留在 extension。
 *
 * 富文本粘贴的 macOS NSPasteboard 行为对照 citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e
 * （MIT License，Copyright (c) 2026 CitroLabs）。本文件未抄入其 JXA 宿主源码。
 */

export type MouseButton = "left" | "middle" | "right";

/** 相对元素左上角的 CSS 像素偏移（与 EGO `position: {x,y}` 同语义）。 */
export type ElementPosition = { x: number; y: number };

export type DomRectLike = { x: number; y: number; width: number; height: number };

export type WheelDeltas = { deltaX: number; deltaY: number };

export type PasteContent = string | { text: string; html?: string };

export type NormalizedPasteContent = { text: string; html?: string };

export type ClipboardFinishStatus = "restored" | "changed";

/**
 * 可注入剪贴板桥：正式宿主接 macOS pasteboard；单测用隔离假剪贴板。
 * 禁止在无桥时用合成 paste/input 事件冒充成功。
 */
export type ClipboardBridge = {
  /** 写入临时 text/html，返回写入后的 changeCount 快照。 */
  beginTemporary(content: NormalizedPasteContent): Promise<{ changeCount: number }>;
  /**
   * 若当前 changeCount 仍等于 begin 时，恢复快照并返回 restored；
   * 若期间有并发变化，不覆盖新内容，返回 changed。
   */
  finish(expectedChangeCount: number): Promise<ClipboardFinishStatus>;
};

/** CDP Input.dispatchMouseEvent 的 button 字段。 */
export function cdpMouseButton(button: MouseButton): MouseButton {
  return button;
}

/** 按下某键时 CDP `buttons` 位掩码：left=1, right=2, middle=4。 */
export function pressedButtonsMask(button: MouseButton): number {
  if (button === "left") return 1;

  if (button === "right") return 2;

  if (button === "middle") return 4;
  throw new Error(`unsupported mouse button: ${button}`);
}

/**
 * 元素内点击点：无 position 时取中心；有则相对左上角 CSS 像素。
 * 结果四舍五入到整数 CSS 像素（不乘 DPR）。
 */
export function pointInElementRect(
  rect: DomRectLike,
  position?: ElementPosition | null,
): [number, number] {
  if (!position) {
    return [
      Math.round(rect.x + rect.width / 2),
      Math.round(rect.y + rect.height / 2),
    ];
  }

  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new Error("position.x / position.y 必须是有限数字（CSS 像素）");
  }

  return [Math.round(rect.x + position.x), Math.round(rect.y + position.y)];
}

export function normalizePasteContent(input: unknown): NormalizedPasteContent {
  if (typeof input === "string") return { text: input };

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("paste 需要 string 或 { text, html? }");
  }

  const value = input as Record<string, unknown>;
  const unknown = Object.keys(value).find((key) => key !== "text" && key !== "html");

  if (unknown) {
    throw new TypeError(`paste 未知字段: ${unknown}`);
  }

  if (typeof value.text !== "string") {
    throw new TypeError("paste content.text 必须是 string");
  }

  if (value.html !== undefined && typeof value.html !== "string") {
    throw new TypeError("paste content.html 必须是 string");
  }

  return value.html === undefined
    ? { text: value.text }
    : { text: value.text, html: value.html };
}

/** macOS → Meta，其它 → Control（EGO ControlOrMeta）。 */
export function controlOrMetaKey(platform: string): "Meta" | "Control" {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "Meta" : "Control";
}

export function pasteChord(platform: string): string {
  return `${controlOrMetaKey(platform)}+V`;
}

/**
 * 隔离假剪贴板：仅进程内状态，绝不触碰用户真实剪贴板。
 * changeCount 在每次成功写入时递增。
 */
export function createIsolatedClipboardBridge(): ClipboardBridge & {
  peek(): { changeCount: number; text: string; html?: string };
  /** 模拟用户/其它进程改剪贴板。 */
  mutateExternal(text: string, html?: string): void;
} {
  let changeCount = 0;
  let text = "";
  let html: string | undefined;
  let saved: { text: string; html?: string } | null = null;

  return {
    async beginTemporary(content) {
      const htmlSnapshot = html !== undefined ? { html } : {};
      saved = { text, ...htmlSnapshot };
      text = content.text;
      html = content.html;
      changeCount += 1;

      return { changeCount };
    },
    async finish(expectedChangeCount) {
      if (changeCount !== expectedChangeCount) {
        saved = null;

        return "changed";
      }

      if (saved) {
        text = saved.text;
        html = saved.html;
        changeCount += 1;
        saved = null;
      }

      return "restored";
    },
    peek() {
      const htmlView = html !== undefined ? { html } : {};

      return { changeCount, text, ...htmlView };
    },
    mutateExternal(nextText, nextHtml) {
      text = nextText;
      html = nextHtml;
      changeCount += 1;
    },
  };
}

/**
 * 指针拖轨迹是否足以证明 HTML5 DataTransfer 投放成功。
 * 期望恒为 false：仅 mouse press/move/release 不能代替带 DataTransfer 的投放读回。
 */
export function pointerDragProvesHtml5DataTransfer(): false {
  return false;
}

/** CDP DragData 形状（Input.dispatchDragEvent），供合并票接协议。 */
export type CdpDragData = {
  items: Array<{ mimeType: string; data: string; title?: string }>;
  files?: string[];
  dragOperationsMask?: number;
};

export type Html5DragParams = {
  from: { target?: string; point?: [number, number]; position?: ElementPosition };
  to: { target?: string; point?: [number, number]; position?: ElementPosition };
  button?: MouseButton;
  label?: string;
  tabId?: number;
};
