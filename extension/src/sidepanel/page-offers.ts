import { onSavedToolsChange } from "./saved-tools.js";
import { onSkillOperationsChange } from "./skill-operations.js";
import type { PageAction } from "./slash-skills.js";

const MAX_OFFERS = 2;

interface PageOffersOptions {
  composerEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  actions: (url: string | null) => PageAction[];
  ready: () => boolean;
}

export function mountPageOffers({ composerEl, inputEl, actions, ready }: PageOffersOptions): { setPage: (url: string | null) => void; sync: () => void } {
  const root = document.createElement("div");
  root.id = "page-offers";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "这页可以");
  root.hidden = true;
  composerEl.parentElement!.insertBefore(root, composerEl);
  let pageUrl: string | null = null;
  let shown = "";

  const sync = (): void => {
    const list = ready() && !inputEl.value.trim() ? actions(pageUrl).slice(0, MAX_OFFERS) : [];
    const signature = list.map(action => action.key).join("|");

    if (signature === shown) return;
    shown = signature;
    root.replaceChildren(...list.map(action => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "page-offer";
      button.dataset.offer = action.key;
      const note = document.createElement("small");
      note.textContent = action.note;
      button.append(action.label, note);
      button.addEventListener("click", () => { root.hidden = true; shown = ""; action.run(); });

      return button;
    }));
    root.hidden = list.length === 0;
  };

  onSavedToolsChange(sync);
  onSkillOperationsChange(sync);
  inputEl.addEventListener("input", sync);

  return { setPage: (url) => { pageUrl = url; sync(); }, sync };
}
