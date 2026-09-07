/**
 * Composer Attachments 管理模块：
 * - 56px squircle 瓷贴与顺时针 SVG Accent Ring 进度描边 (周长 194px)
 * - 右上角 9px 百分比数字与关闭按钮 ✕ 原位 Blur Cross-Fade (Zero Layout Shift)
 * - 交互源支持：
 *   1. 📸 截取当前网页视口 (向 background 请求 sidepanel_capture_tab)
 *   2. 📁 上传本地图片 (文件选择器)
 *   3. 剪贴板 Cmd+V / Ctrl+V 粘贴图片
 *   4. 拖拽图片至输入区域
 */

import type { ImageAttachment } from "../../../shared/protocol.js";

export const TILE_PERIMETER = 194;

export type SupportedImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface AttachmentsManagerOptions {
  composerEl: HTMLElement;
  stripEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  attachBtn: HTMLButtonElement;
  menuEl: HTMLElement;
  fileInputEl: HTMLInputElement;
  onChanged?: (count: number) => void;
  onError?: (errMessage: string) => void;
}

export interface AttachmentItem {
  id: string;
  name: string;
  mimeType: SupportedImageMime;
  dataBase64: string; // base64 without prefix
  dataUrl: string;
  width?: number;
  height?: number;
  dom: {
    tile: HTMLElement;
    path: SVGPathElement | SVGRectElement;
    pText: HTMLElement;
    dismissBtn: HTMLElement;
  };
}

export function parseDataUrl(dataUrl: string): { mimeType: SupportedImageMime; dataBase64: string } {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.*)$/);
  if (match && match[1] && match[2]) {
    const rawMime = match[1].toLowerCase();
    const mimeType: SupportedImageMime =
      rawMime === "image/jpeg" || rawMime === "image/webp" || rawMime === "image/gif"
        ? rawMime
        : "image/png";
    return { mimeType, dataBase64: match[2] };
  }
  return { mimeType: "image/png", dataBase64: dataUrl.replace(/^data:[^;]+;base64,/, "") };
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
}

export class AttachmentsManager {
  private items: AttachmentItem[] = [];
  private readonly composerEl: HTMLElement;
  private readonly stripEl: HTMLElement;
  private readonly inputEl: HTMLTextAreaElement;
  private readonly attachBtn: HTMLButtonElement;
  private readonly menuEl: HTMLElement;
  private readonly fileInputEl: HTMLInputElement;
  private readonly onChanged?: (count: number) => void;
  private readonly onError?: (errMessage: string) => void;

  constructor(opts: AttachmentsManagerOptions) {
    this.composerEl = opts.composerEl;
    this.stripEl = opts.stripEl;
    this.inputEl = opts.inputEl;
    this.attachBtn = opts.attachBtn;
    this.menuEl = opts.menuEl;
    this.fileInputEl = opts.fileInputEl;
    this.onChanged = opts.onChanged;
    this.onError = opts.onError;

    this.bindEvents();
    this.updateVisibility();
  }

  private bindEvents(): void {
    // 1. + 按钮呼出/收起动作菜单
    this.attachBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleMenu();
    });

    // 点击页面任意外部关闭菜单
    document.addEventListener("click", (e) => {
      if (
        !this.menuEl.hidden &&
        !this.menuEl.contains(e.target as Node) &&
        !this.attachBtn.contains(e.target as Node)
      ) {
        this.closeMenu();
      }
    });

    // 2. 菜单内动作点击
    const screenshotBtn = this.menuEl.querySelector("#menu-action-screenshot");
    screenshotBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeMenu();
      void this.captureActiveTab();
    });

    const uploadBtn = this.menuEl.querySelector("#menu-action-upload");
    uploadBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeMenu();
      this.fileInputEl.click();
    });

    // 3. 文件选择触发
    this.fileInputEl.addEventListener("change", () => {
      const files = Array.from(this.fileInputEl.files || []);
      if (files.length > 0) {
        void this.addFiles(files);
      }
      this.fileInputEl.value = "";
    });

    // 4. 输入框剪贴板粘贴
    this.inputEl.addEventListener("paste", (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items || items.length === 0) return;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        void this.addFiles(imageFiles);
      }
    });

    // 5. 拖拽到 composer 区域
    let dragCounter = 0;
    this.composerEl.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragCounter++;
      this.composerEl.classList.add("drag-over");
    });
    this.composerEl.addEventListener("dragover", (e) => {
      e.preventDefault();
    });
    this.composerEl.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        this.composerEl.classList.remove("drag-over");
      }
    });
    this.composerEl.addEventListener("drop", (e) => {
      e.preventDefault();
      dragCounter = 0;
      this.composerEl.classList.remove("drag-over");
      const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith("image/"));
      if (files.length > 0) {
        void this.addFiles(files);
      }
    });
  }

  public toggleMenu(open?: boolean): void {
    const willOpen = open !== undefined ? open : Boolean(this.menuEl.hidden);
    this.menuEl.hidden = !willOpen;
    this.attachBtn.classList.toggle("active", willOpen);
  }

  public closeMenu(): void {
    this.menuEl.hidden = true;
    this.attachBtn.classList.remove("active");
  }

  /**
   * 截取当前激活网页视口
   */
  public async captureActiveTab(): Promise<void> {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
        throw new Error("Chrome 运行环境不可用");
      }
      const res = await new Promise<{ ok: boolean; dataUrl?: string; title?: string; error?: string }>((resolve) => {
        chrome.runtime.sendMessage({ type: "sidepanel_capture_tab" }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response || { ok: false, error: "未收到响应" });
          }
        });
      });

      if (!res.ok || !res.dataUrl) {
        throw new Error(res.error || "截取视口失败");
      }

      const name = `${(res.title || "网页截屏").replace(/[/\\?%*:|"<>]/g, "_")}.png`;
      await this.addFromDataUrl(res.dataUrl, name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.onError) this.onError(`截屏失败: ${msg}`);
      else console.error("[sideagent-attachments] captureActiveTab failed:", err);
    }
  }

  /**
   * 批量加入文件对象（带入场错峰 stagger）
   */
  public async addFiles(files: File[], staggerMs = 80): Promise<void> {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;
      if (i > 0 && staggerMs > 0) {
        await new Promise((r) => setTimeout(r, staggerMs));
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        await this.addFromDataUrl(dataUrl, file.name);
      } catch (err) {
        console.error("[sideagent-attachments] addFile failed:", file.name, err);
      }
    }
  }

  /**
   * 从 dataUrl 加入单枚瓷贴
   */
  public async addFromDataUrl(dataUrl: string, name?: string): Promise<AttachmentItem> {
    const { mimeType, dataBase64 } = parseDataUrl(dataUrl);
    const { width, height } = await getImageDimensions(dataUrl);
    const id = "att_" + Math.random().toString(36).slice(2, 9);
    const safeName = name || `image_${Date.now()}.png`;

    const dom = this.createTileDom(id, safeName, dataUrl);
    const item: AttachmentItem = {
      id,
      name: safeName,
      mimeType,
      dataBase64,
      dataUrl,
      width,
      height,
      dom,
    };

    this.items.push(item);
    this.stripEl.appendChild(dom.tile);
    this.updateVisibility();

    // 顺滑滚到最新一项
    this.stripEl.scrollTo({ left: this.stripEl.scrollWidth, behavior: "smooth" });

    // 运行 0% -> 100% 顺时针 Ring 描边与数字动效 (380ms 顺畅感知)
    this.animateTileProgress(item, 380);

    return item;
  }

  private createTileDom(id: string, name: string, dataUrl: string): AttachmentItem["dom"] {
    const tile = document.createElement("div");
    tile.className = "tile-56 tile-landing";
    tile.dataset.id = id;

    // 1. 缩略图
    const img = document.createElement("img");
    img.className = "tile-img";
    img.src = dataUrl;
    img.alt = name;
    tile.appendChild(img);

    // 2. 顺时针 Accent Ring 描边 SVG (56x56 容器，rx=11)
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "tile-ring-svg");
    svg.setAttribute("viewBox", "0 0 56 56");
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("class", "tile-ring-path");
    rect.setAttribute("x", "1.5");
    rect.setAttribute("y", "1.5");
    rect.setAttribute("width", "53");
    rect.setAttribute("height", "53");
    rect.setAttribute("rx", "11");
    svg.appendChild(rect);
    tile.appendChild(svg);

    // 3. 右上角 9px 百分比数字
    const pText = document.createElement("span");
    pText.className = "tile-progress-text";
    pText.textContent = "0%";
    tile.appendChild(pText);

    // 4. 同坐标原位关闭按钮 ✕ (Zero Layout Shift)
    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "tile-dismiss-btn";
    dismissBtn.innerHTML = "✕";
    dismissBtn.title = "移除该附件";
    dismissBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.removeItem(id);
    });
    tile.appendChild(dismissBtn);

    return { tile, path: rect, pText, dismissBtn };
  }

  private animateTileProgress(item: AttachmentItem, durationMs = 380): void {
    const { tile, path, pText } = item.dom;
    const start = performance.now();

    const step = (timestamp: number) => {
      const elapsed = timestamp - start;
      const progress = Math.min(elapsed / durationMs, 1);
      // 正弦缓动节奏
      const eased = Math.sin((progress * Math.PI) / 2);
      const percent = Math.round(eased * 100);

      pText.textContent = `${percent}%`;
      const offset = TILE_PERIMETER - (TILE_PERIMETER * percent) / 100;
      path.style.strokeDashoffset = String(offset);

      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        pText.textContent = "100%";
        tile.classList.add("complete");
      }
    };

    requestAnimationFrame(step);
  }

  public removeItem(id: string): void {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return;
    const removed = this.items.splice(index, 1);
    const item = removed[0];
    if (!item) return;
    item.dom.tile.classList.add("removing");
    setTimeout(() => {
      item.dom.tile.remove();
      this.updateVisibility();
    }, 250);
  }

  public clear(): void {
    for (const item of this.items) {
      item.dom.tile.remove();
    }
    this.items = [];
    this.updateVisibility();
  }

  public getAttachments(): ImageAttachment[] {
    return this.items.map((item) => ({
      type: "image",
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      dataBase64: item.dataBase64,
    }));
  }

  public hasPending(): boolean {
    return this.items.length > 0;
  }

  private updateVisibility(): void {
    const hasItems = this.items.length > 0;
    this.stripEl.hidden = !hasItems;
    if (this.onChanged) this.onChanged(this.items.length);
  }
}
