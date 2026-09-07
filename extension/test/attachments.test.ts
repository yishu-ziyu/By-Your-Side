import { describe, expect, it } from "vitest";
import {
  AttachmentsManager,
  TILE_PERIMETER,
  parseDataUrl,
} from "../src/sidepanel/attachments.js";
import { isAttachment } from "../../shared/protocol.js";

describe("attachments utility functions", () => {
  it("parses image/png data url correctly", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const res = parseDataUrl(dataUrl);
    expect(res.mimeType).toBe("image/png");
    expect(res.dataBase64).toBe("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
  });

  it("parses image/jpeg, webp, and gif correctly", () => {
    const jpeg = parseDataUrl("data:image/jpeg;base64,/9j/4AAQSkZJRg==");
    expect(jpeg.mimeType).toBe("image/jpeg");
    expect(jpeg.dataBase64).toBe("/9j/4AAQSkZJRg==");

    const webp = parseDataUrl("data:image/webp;base64,UklGRiQAAABXRUJQVlA4");
    expect(webp.mimeType).toBe("image/webp");
    expect(webp.dataBase64).toBe("UklGRiQAAABXRUJQVlA4");

    const gif = parseDataUrl("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
    expect(gif.mimeType).toBe("image/gif");
    expect(gif.dataBase64).toBe("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
  });

  it("falls back to image/png for unsupported or unrecognised mime formats", () => {
    const raw = parseDataUrl("data:application/octet-stream;base64,AQID");
    expect(raw.mimeType).toBe("image/png");
    expect(raw.dataBase64).toBe("AQID");
  });

  it("specifies correct squircle perimeter of 194px", () => {
    expect(TILE_PERIMETER).toBe(194);
  });
});

describe("AttachmentsManager DOM & state management", () => {
  function createMockElement(tag = "div"): any {
    const children: any[] = [];
    const classList = new Set<string>();
    const listeners: Record<string, Function[]> = {};
    const dataset: Record<string, string> = {};
    const style: Record<string, string> = {};

    const el: any = {
      tagName: tag.toUpperCase(),
      hidden: false,
      dataset,
      style,
      children,
      classList: {
        add: (cls: string) => classList.add(cls),
        remove: (cls: string) => classList.delete(cls),
        toggle: (cls: string, force?: boolean) => {
          const val = force !== undefined ? force : !classList.has(cls);
          if (val) classList.add(cls);
          else classList.delete(cls);
          return val;
        },
        contains: (cls: string) => classList.has(cls),
      },
      appendChild: (child: any) => {
        children.push(child);
        return child;
      },
      replaceChildren: (...next: any[]) => { children.splice(0, children.length, ...next); },
      removeChild: (child: any) => {
        const idx = children.indexOf(child);
        if (idx !== -1) children.splice(idx, 1);
        return child;
      },
      remove: () => {
        if (el.parentNode) {
          el.parentNode.removeChild(el);
        }
      },
      setAttribute: (k: string, v: string) => {
        if (k === "class") {
          v.split(/\s+/).forEach((c) => c && classList.add(c));
        }
        el[k] = v;
      },
      getAttribute: (k: string) => el[k],
      addEventListener: (evt: string, fn: Function) => {
        listeners[evt] = listeners[evt] || [];
        listeners[evt].push(fn);
      },
      querySelector: (selector: string) => {
        if (selector === "#menu-action-screenshot") return createMockElement("div");
        if (selector === "#menu-action-upload") return createMockElement("div");
        return null;
      },
      scrollTo: () => {},
      scrollWidth: 100,
    };

    let _className = "";
    Object.defineProperty(el, "className", {
      get: () => _className,
      set: (val: string) => {
        _className = val;
        classList.clear();
        val.split(/\s+/).forEach((c) => c && classList.add(c));
      },
    });

    return el;
  }

  it("manages items and visibility correctly", async () => {
    // Setup global minimal DOM environment for node test
    const origDoc = (globalThis as any).document;
    const origImage = (globalThis as any).Image;
    const origRaf = (globalThis as any).requestAnimationFrame;

    try {
      const mockDoc = {
        createElement: (tag: string) => createMockElement(tag),
        createElementNS: (_ns: string, tag: string) => createMockElement(tag),
        addEventListener: () => {},
      } as any;
      (globalThis as any).document = mockDoc;

      const mockImage = class {
        onload: any = null;
        naturalWidth = 100;
        naturalHeight = 80;
        set src(_v: string) {
          if (this.onload) setTimeout(this.onload, 0);
        }
      } as any;
      (globalThis as any).Image = mockImage;

      const mockRaf = (cb: any) => {
        cb(performance.now() + 1000);
        return 1;
      };
      (globalThis as any).requestAnimationFrame = mockRaf;

      const composerEl = createMockElement();
      const stripEl = createMockElement();
      const inputEl = createMockElement("textarea");
      const attachBtn = createMockElement("button");
      const menuEl = createMockElement();
      const fileInputEl = createMockElement("input");

      let changedCount = -1;
      const manager = new AttachmentsManager({
        composerEl,
        stripEl,
        inputEl,
        attachBtn,
        menuEl,
        fileInputEl,
        onChanged: (cnt) => {
          changedCount = cnt;
        },
      });

      expect(manager.hasPending()).toBe(false);
      expect(stripEl.hidden).toBe(true);

      // Simulate adding a dataUrl
      const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const item = await manager.addFromDataUrl(dataUrl, "test_pic.png");

      expect(manager.hasPending()).toBe(true);
      expect(stripEl.hidden).toBe(false);
      expect(changedCount).toBe(1);

      const atts = manager.getAttachments();
      expect(atts).toHaveLength(1);
      expect(atts[0]?.name).toBe("test_pic.png");
      expect(atts[0]?.mimeType).toBe("image/png");
      expect(isAttachment(atts[0])).toBe(true);

      // Verify squircle tile structure
      expect(item.dom.tile.classList.contains("tile-56")).toBe(true);
      expect(item.dom.tile.classList.contains("tile-landing")).toBe(true);

      // Clear
      manager.clear();
      expect(manager.hasPending()).toBe(false);
      expect(stripEl.hidden).toBe(true);
      expect(manager.getAttachments()).toHaveLength(0);
    } finally {
      (globalThis as any).document = origDoc;
      (globalThis as any).Image = origImage;
      (globalThis as any).requestAnimationFrame = origRaf;
    }
  });
  it("keeps an in-flight attachment in its original conversation when the user switches", async () => {
    const previous = { document: globalThis.document, Image: globalThis.Image, raf: globalThis.requestAnimationFrame };
    let finishImage: (() => void) | undefined;
    try {
      (globalThis as any).document = {
        createElement: createMockElement,
        createElementNS: (_ns: string, tag: string) => createMockElement(tag),
        addEventListener: () => {},
      };
      (globalThis as any).Image = class {
        onload?: () => void;
        naturalWidth = 1;
        naturalHeight = 1;
        set src(_value: string) { finishImage = () => this.onload?.(); }
      };
      (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(performance.now() + 1000); return 1; };
      const stripEl = createMockElement();
      const changes: string[] = [];
      const manager = new AttachmentsManager({
        composerEl: createMockElement(), stripEl, inputEl: createMockElement("textarea"),
        attachBtn: createMockElement("button"), menuEl: createMockElement(), fileInputEl: createMockElement("input"),
        onChanged: (_count, scope) => { if (scope) changes.push(scope); },
      });
      manager.restore([], "A");
      const pending = manager.addFromDataUrl("data:image/png;base64,AQID", "A.png");
      manager.restore([], "B");
      finishImage?.();
      await pending;
      expect(manager.getAttachments()).toEqual([]);
      expect(stripEl.children).toHaveLength(0);
      expect(manager.getAttachments("A").map(a => a.name)).toEqual(["A.png"]);
      expect(changes.at(-1)).toBe("A");
      const saved = manager.getAttachments("A");
      manager.restore(saved, "A");
      expect(manager.getAttachments()).toEqual(saved);
      expect(stripEl.children).toHaveLength(1);
      manager.restore([], "B");
      manager.clear();
      expect(manager.getAttachments("A")).toEqual(saved);
    } finally {
      globalThis.document = previous.document;
      globalThis.Image = previous.Image;
      globalThis.requestAnimationFrame = previous.raf;
    }
  });

});
