/**
 * Composer Attachments 管理模块：
 * - 56px squircle 瓷贴与顺时针 SVG Accent Ring 进度描边 (周长 194px)
 * - 右上角 9px 百分比数字与关闭按钮 ✕ 原位 Blur Cross-Fade (Zero Layout Shift)
 * - 交互源支持：
 *   1. 📸 截取当前网页视口 (向 background 请求 sidepanel_capture_tab)
 *   2. 📁 上传本地图片或文件（PDF、Word、Excel、PPT、CSV、文本）
 *   3. 剪贴板 Cmd+V / Ctrl+V 粘贴图片或文件
 *   4. 拖拽图片或文件至输入区域
 * 文件在侧栏本机读成文字（file-read.js 用到时才加载）；瓷贴的进度环跟着真实的读取进度走。
 */

import { isAttachment, type Attachment, type FileAttachment, type FileFormat, type ImageAttachment } from "../../../shared/protocol.js";
import { isCircling, removeCircle, startCircling } from "./circle-select.js";
import { fileChip, fileMeta } from "./file-chip.js";
import { readableFormat, unsupportedReason } from "./file-read/formats.js";

/** 一条消息最多带这么多个附件（与任务核心接收的上限一致）。 */
const ATTACHMENTS_MAX = 16;

type FileReadModule = typeof import("./file-read/index.js");

let fileReadModule: Promise<FileReadModule> | null = null;

/** 解析代码单独打包成 file-read.js：第一次附上文件时才加载。 */
function loadFileRead(): Promise<FileReadModule> {
  fileReadModule ??= import(chrome.runtime.getURL("file-read.js")) as Promise<FileReadModule>;
  fileReadModule.catch(() => { fileReadModule = null; });

  return fileReadModule;
}

const TILE_PERIMETER = 194;

/** 文件瓷贴更宽，放得下文件名；进度环的周长随之变。 */
const FILE_TILE_WIDTH = 176;
const FILE_TILE_PERIMETER = Math.round(2 * (FILE_TILE_WIDTH - 3 + 53) - (8 - 2 * Math.PI) * 11);

/** 走图片附件的类型：模型直接看图。 */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

type SupportedImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

interface AttachmentsManagerOptions {
  composerEl: HTMLElement;
  stripEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  attachBtn: HTMLButtonElement;
  menuEl: HTMLElement;
  fileInputEl: HTMLInputElement;
  onChanged?: (count: number, scope?: string) => void;
  /** 读取进度或完成状态变化；只刷新展示，不触发草稿重写。 */
  onDisplayChanged?: (scope?: string) => void;
  onError?: (errMessage: string) => void;
}

export interface AttachmentSnapshot {
  id: string;
  name: string;
  detail: string;
  state: "reading" | "ready";
}

interface FileItem {
  kind: "file";
  id: string;
  name: string;
  format: FileFormat;
  /** 读好之前没有；发消息时只带读好的。 */
  attachment: FileAttachment | null;
  ready: Promise<void>;
  dom: AttachmentItem["dom"];
}

interface AttachmentItem {
  kind: "image";
  id: string;
  name: string;
  mimeType: SupportedImageMime;
  dataBase64: string; // base64 without prefix
  dataUrl: string;
  /** 圈出来问的第几圈；去掉这张时页面上那一圈也去掉。 */
  circle?: number;
  /** 圈内的网页文字，随图交给助手。 */
  note?: string;
  width?: number;
  height?: number;
  dom: {
    tile: HTMLElement;
    path: SVGPathElement | SVGRectElement;
    pText: HTMLElement;
    dismissBtn: HTMLElement;
  };
}

function parseDataUrl(dataUrl: string): { mimeType: SupportedImageMime; dataBase64: string } {
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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
}

export class AttachmentsManager {
  private readonly itemsByScope = new Map<string, Array<AttachmentItem | FileItem>>();
  private scopeId = "default";
  private get items(): Array<AttachmentItem | FileItem> { return this.scopeItems(this.scopeId); }
  private set items(items: Array<AttachmentItem | FileItem>) { this.itemsByScope.set(this.scopeId, items); }
  private scopeItems(scope: string): Array<AttachmentItem | FileItem> {
    let items = this.itemsByScope.get(scope);

    if (!items) { items = []; this.itemsByScope.set(scope, items); }

    return items;
  }

  public restore(attachments: Attachment[], scope: string): void {
    this.scopeId = scope;
    this.closeMenu();
    this.stripEl.replaceChildren();
    this.items = (Array.isArray(attachments) ? attachments : []).filter(isAttachment).map((att): AttachmentItem | FileItem => {
      if (att.type === "file") {
        const dom = this.createFileTileDom(att.id, att, scope);
        dom.tile.classList.add("complete");
        dom.pText.textContent = "100%";
        dom.path.style.strokeDashoffset = "0";
        this.stripEl.appendChild(dom.tile);

        return { kind: "file", id: att.id, name: att.name, format: att.format, attachment: att, ready: Promise.resolve(), dom };
      }

      const dataUrl = `data:${att.mimeType};base64,${att.dataBase64}`;
      const dom = this.createTileDom(att.id, att.name, dataUrl, scope);
      dom.tile.classList.add("complete");
      dom.pText.textContent = "100%";
      dom.path.style.strokeDashoffset = "0";
      this.stripEl.appendChild(dom.tile);

      return { ...att, kind: "image", dataUrl, dom };
    });
    this.updateVisibility();
    this.notifyDisplayChanged();
  }
  private readonly composerEl: HTMLElement;
  private readonly stripEl: HTMLElement;
  private readonly inputEl: HTMLTextAreaElement;
  private readonly attachBtn: HTMLButtonElement;
  private readonly menuEl: HTMLElement;
  private readonly fileInputEl: HTMLInputElement;
  private readonly onChanged?: (count: number, scope?: string) => void;
  private readonly onDisplayChanged?: (scope?: string) => void;
  private readonly onError?: (errMessage: string) => void;

  constructor(opts: AttachmentsManagerOptions) {
    this.composerEl = opts.composerEl;
    this.stripEl = opts.stripEl;
    this.inputEl = opts.inputEl;
    this.attachBtn = opts.attachBtn;
    this.menuEl = opts.menuEl;
    this.fileInputEl = opts.fileInputEl;
    this.onChanged = opts.onChanged;
    this.onDisplayChanged = opts.onDisplayChanged;
    this.onError = opts.onError;

    this.bindEvents();
    this.updateVisibility();
    this.notifyDisplayChanged();
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

    // 圈出来问：菜单项，或侧栏里按 ⌘/Ctrl+Shift+S。
    const regionBtn = this.menuEl.querySelector("#menu-action-region");
    regionBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeMenu();
      void this.captureRegion();
    });
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "s" && !e.isComposing) {
        e.preventDefault();
        this.closeMenu();
        void this.captureRegion();
      }
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
      const files: File[] = [];

      // 复制的文件（访达里 ⌘C）和截图一样出现在剪贴板的文件项里；纯文字粘贴照常进输入框。
      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        if (item?.kind === "file") {
          const file = item.getAsFile();

          if (file) files.push(file);
        }
      }

      if (files.length > 0) {
        e.preventDefault();
        void this.addFiles(files);
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
      const files = Array.from(e.dataTransfer?.files || []);

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
    const scope = this.scopeId;

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

      const name = `${(res.title || "页面截图").replace(/[/\\?%*:|"<>]/g, "_")}.png`;
      await this.addFromDataUrl(res.dataUrl, name, scope);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (this.onError) this.onError(`截图失败：${msg}`);
      else console.error("[sideagent-attachments] captureActiveTab failed:", err);
    }
  }

  /**
   * 圈出来问：进入圈画，每圈一处加一张带编号的附件；编号接着输入框上方已有的圈往下数。不发送。
   */
  public async captureRegion(): Promise<void> {
    if (isCircling()) return;
    const scope = this.scopeId;
    const start = Math.max(0, ...this.scopeItems(scope).map(item => (item.kind === "image" ? item.circle ?? 0 : 0))) + 1;

    try {
      await startCircling(start, async (dataUrl, n, text) => {
        const item = await this.addFromDataUrl(dataUrl, `圈 ${n}.png`, scope, n);

        if (text) item.note = text;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (this.onError) this.onError(`圈不了：${msg}`);
      else console.error("[sideagent-attachments] captureRegion failed:", err);
    }
  }

  /**
   * 批量加入文件对象（带入场错峰 stagger）
   */
  public async addFiles(files: File[], staggerMs = 80): Promise<void> {
    const scope = this.scopeId;
    const rejected: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      if (!file) continue;

      if (this.scopeItems(scope).length >= ATTACHMENTS_MAX) {
        rejected.push(`一条消息最多附 ${ATTACHMENTS_MAX} 个文件，${file.name} 没有附上。`);
        continue;
      }

      if (i > 0 && staggerMs > 0) {
        await new Promise((r) => setTimeout(r, staggerMs));
      }

      if (IMAGE_TYPES.has(file.type)) {
        try {
          const dataUrl = await readFileAsDataUrl(file);
          await this.addFromDataUrl(dataUrl, file.name, scope);
        } catch (err) {
          rejected.push(`${file.name} 没读出来：${err instanceof Error ? err.message : String(err)}`);
        }

        continue;
      }

      if (!readableFormat(file)) {
        rejected.push(unsupportedReason(file));
        continue;
      }

      this.addDocument(file, scope);
    }

    if (rejected.length) this.onError?.(rejected.join("\n"));
  }

  /** 先摆出瓷贴，后台读文件：进度环跟着读取进度走，读不出来就撤下瓷贴并说明原因。 */
  private addDocument(file: File, scope: string): void {
    const id = "att_" + Math.random().toString(36).slice(2, 9);
    const format = readableFormat(file)!;
    const dom = this.createFileTileDom(id, { name: file.name, format, size: file.size }, scope, "正在读…");
    let item!: FileItem;
    const ready = (async () => {
      const progress = (fraction: number) => this.paintProgress(dom, fraction, scope);

      try {
        progress(0.04);
        const read = await loadFileRead();
        const attachment = await read.readAttachmentFile(file, id, progress);

        item.attachment = attachment;
        dom.tile.querySelector(".file-chip-meta")!.textContent = fileMeta(attachment);

        if (attachment.note) dom.tile.title = attachment.note;
        this.paintProgress(dom, 1);
        dom.tile.classList.add("complete");
        this.updateVisibility(scope);
        this.notifyDisplayChanged(scope);
      } catch (error) {
        this.removeItem(id, scope);
        this.onError?.(error instanceof Error ? error.message : String(error));
      }
    })();

    item = { kind: "file", id, name: file.name, format, attachment: null, ready, dom };
    this.scopeItems(scope).push(item);
    this.notifyDisplayChanged(scope);

    if (scope === this.scopeId) {
      this.stripEl.appendChild(dom.tile);
      this.stripEl.scrollTo({ left: this.stripEl.scrollWidth, behavior: "smooth" });
    }

    this.updateVisibility(scope);
  }

  private paintProgress(dom: AttachmentItem["dom"], fraction: number, scope = this.scopeId): void {
    const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    dom.pText.textContent = `${percent}%`;
    dom.path.style.strokeDashoffset = String(FILE_TILE_PERIMETER - (FILE_TILE_PERIMETER * percent) / 100);
    this.notifyDisplayChanged(scope);
  }

  /** 还在读的文件：发送前要等它们读完。 */
  public reading(scope = this.scopeId): number {
    return this.scopeItems(scope).filter(item => item.kind === "file" && !item.attachment).length;
  }

  public whenRead(scope = this.scopeId): Promise<void> {
    return Promise.all(this.scopeItems(scope).flatMap(item => (item.kind === "file" ? [item.ready] : []))).then(() => {});
  }

  /**
   * 从 dataUrl 加入单枚瓷贴
   */
  public async addFromDataUrl(dataUrl: string, name?: string, scope = this.scopeId, circle?: number): Promise<AttachmentItem> {
    const { mimeType, dataBase64 } = parseDataUrl(dataUrl);
    const { width, height } = await getImageDimensions(dataUrl);
    const id = "att_" + Math.random().toString(36).slice(2, 9);
    const safeName = name || `image_${Date.now()}.png`;

    const dom = this.createTileDom(id, safeName, dataUrl, scope, circle);

    const item: AttachmentItem = {
      kind: "image",
      id,
      name: safeName,
      mimeType,
      dataBase64,
      dataUrl,
      width,
      height,
      dom,
    };


    if (circle) item.circle = circle;
    this.scopeItems(scope).push(item);

    if (scope === this.scopeId) {
      this.stripEl.appendChild(dom.tile);
      this.stripEl.scrollTo({ left: this.stripEl.scrollWidth, behavior: "smooth" });
    }

    this.updateVisibility(scope);
    this.notifyDisplayChanged(scope);

    // 运行 0% -> 100% 顺时针 Ring 描边与数字动效 (380ms 顺畅感知)
    this.animateTileProgress(item, 380);

    return item;
  }

  private createTileDom(id: string, name: string, dataUrl: string, scope = this.scopeId, circle?: number): AttachmentItem["dom"] {
    const tile = document.createElement("div");
    tile.className = "tile-56 tile-landing";
    tile.dataset.id = id;

    // 1. 缩略图
    const img = document.createElement("img");
    img.className = "tile-img";
    img.src = dataUrl;
    img.alt = name;
    tile.appendChild(img);

    // 圈出来问的附件：左上角是页面上那一圈的编号。
    if (circle) {
      const num = document.createElement("span");
      num.className = "tile-circle-num";
      num.textContent = String(circle);
      tile.dataset.circle = String(circle);
      tile.appendChild(num);
    }

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
    dismissBtn.title = circle ? "去掉这一圈" : "移除该附件";
    dismissBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.removeItem(id, scope);
    });
    tile.appendChild(dismissBtn);

    return { tile, path: rect, pText, dismissBtn };
  }

  private createFileTileDom(id: string, file: Pick<FileAttachment, "name" | "format" | "size"> & Partial<FileAttachment>, scope = this.scopeId, pending?: string): AttachmentItem["dom"] {
    const tile = document.createElement("div");
    tile.className = "tile-56 tile-file tile-landing";
    tile.dataset.id = id;
    tile.dataset.format = file.format;
    const chip = fileChip(file.name, file.format, pending ?? fileMeta({ format: file.format, parts: file.parts, size: file.size }));
    tile.appendChild(chip.el);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "tile-ring-svg");
    svg.setAttribute("viewBox", `0 0 ${FILE_TILE_WIDTH} 56`);
    svg.setAttribute("preserveAspectRatio", "none");
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("class", "tile-ring-path");
    rect.setAttribute("x", "1.5");
    rect.setAttribute("y", "1.5");
    rect.setAttribute("width", String(FILE_TILE_WIDTH - 3));
    rect.setAttribute("height", "53");
    rect.setAttribute("rx", "11");
    rect.style.strokeDasharray = String(FILE_TILE_PERIMETER);
    rect.style.strokeDashoffset = String(FILE_TILE_PERIMETER);
    svg.appendChild(rect);
    tile.appendChild(svg);

    const pText = document.createElement("span");
    pText.className = "tile-progress-text";
    pText.textContent = "0%";
    tile.appendChild(pText);

    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "tile-dismiss-btn";
    dismissBtn.innerHTML = "✕";
    dismissBtn.title = "移除这个文件";
    dismissBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.removeItem(id, scope);
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

  public removeItem(id: string, scope = this.scopeId): void {
    const items = this.scopeItems(scope);
    const index = items.findIndex((item) => item.id === id);

    if (index === -1) return;
    const removed = items.splice(index, 1);
    const item = removed[0];

    if (!item) return;

    if (item.kind === "image" && item.circle) removeCircle(item.circle);
    item.dom.tile.classList.add("removing");
    this.updateVisibility(scope);
    this.notifyDisplayChanged(scope);
    setTimeout(() => { item.dom.tile.remove(); }, 250);
  }

  public clear(): void {
    for (const item of this.items) {
      item.dom.tile.remove();
    }

    this.items = [];
    this.updateVisibility();
    this.notifyDisplayChanged();
  }

  /** 发消息要带的附件：图片和已读好的文件（还在读的不带，发送前先 whenRead）。 */
  public getAttachments(scope = this.scopeId): Attachment[] {
    return this.scopeItems(scope).flatMap((item): Attachment[] => {
      if (item.kind === "file") return item.attachment ? [item.attachment] : [];
      const attachment: ImageAttachment = { type: "image", id: item.id, name: item.name, mimeType: item.mimeType, dataBase64: item.dataBase64 };

      if (item.note) attachment.note = item.note;

      if (item.circle) attachment.circle = item.circle;

      return [attachment];
    });
  }

  public hasPending(): boolean {
    return this.items.length > 0;
  }

  public snapshot(scope = this.scopeId): AttachmentSnapshot[] {
    return this.scopeItems(scope).map((item): AttachmentSnapshot => {
      if (item.kind === "image") {
        return {
          id: item.id,
          name: item.name,
          detail: item.circle ? `圈选图片 · 圈 ${item.circle}` : "图片 · 已读",
          state: "ready",
        };
      }

      if (!item.attachment) {
        return {
          id: item.id,
          name: item.name,
          detail: `${item.format.toUpperCase()} · ${item.dom.pText.textContent ?? "正在读取"}`,
          state: "reading",
        };
      }

      return {
        id: item.id,
        name: item.name,
        detail: fileMeta(item.attachment),
        state: "ready",
      };
    });
  }

  private updateVisibility(scope = this.scopeId): void {
    const items = this.scopeItems(scope);

    if (scope === this.scopeId) this.stripEl.hidden = items.length === 0;

    if (this.onChanged) this.onChanged(items.length, scope);
  }

  private notifyDisplayChanged(scope = this.scopeId): void {
    this.onDisplayChanged?.(scope);
  }
}
