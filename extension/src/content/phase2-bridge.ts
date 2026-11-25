import type { Phase2ContentMessage } from "../../../shared/page-phase2.js";
import { InteractiveGuideSession } from "./interactive-guide.js";
import { PageSkimLayer } from "./page-skim.js";
import { PageTransformLedger } from "./page-transform.js";

let installed = false;

export function installPhase2Bridge(): void {
  if (installed) return;
  installed = true;

  const skim = new PageSkimLayer();
  const guide = new InteractiveGuideSession();
  const transform = new PageTransformLedger();

  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    if (!raw || typeof raw !== "object" || !("type" in raw)) return;
    const msg = raw as Phase2ContentMessage;

    try {
      return answer(msg, sendResponse);
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return true;
    }
  });

  function answer(msg: Phase2ContentMessage, sendResponse: (response: unknown) => void): true | undefined {
    if (msg.type === "bys_page_skim") {
      sendResponse({ ok: true, ...skim.apply(msg.points) });
      return true;
    }
    if (msg.type === "bys_page_skim_clear") {
      skim.clear();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "bys_interactive_guide_start") {
      sendResponse({ ok: guide.start(msg.steps) });
      return true;
    }
    if (msg.type === "bys_interactive_guide_stop") {
      guide.stop();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "bys_page_transform_apply") {
      sendResponse({ ok: true, ...transform.applyMany(msg.actions), count: transform.count });
      return true;
    }
    if (msg.type === "bys_page_transform_restore") {
      sendResponse({ ok: true, restored: transform.restoreAll() });
      return true;
    }
    if (msg.type === "bys_selector_extract") {
      const data: Record<string, string> = {};
      for (const field of msg.fields) {
        const el = document.querySelector<HTMLElement>(field.selector);
        data[field.name] = el?.innerText?.trim() ?? el?.textContent?.trim() ?? "";
      }
      sendResponse({ ok: true, data });
      return true;
    }
    return undefined;
  }
}
