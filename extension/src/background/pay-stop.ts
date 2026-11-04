import { OVERLAY_ATTR, OVERLAY_KIND_PAY_STOP } from "../shared/overlay.js";
import { bringForwardForUser } from "./foreground.js";
import type { HeldReason } from "../../../shared/protocol.js";

function showPayStop(attr: string, kind: string, label: string, x: number, y: number): void {
  document.querySelectorAll(`[${attr}="${kind}"]`).forEach(node => node.remove());
  const host = document.createElement("div");
  host.setAttribute(attr, kind);
  host.style.cssText = "all:initial;display:block;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
.ring{position:fixed;border:3px solid #ff9f0a;border-radius:10px;box-shadow:0 0 0 4px rgba(255,159,10,.25);pointer-events:none}
.cap{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;max-width:min(420px,calc(100vw - 32px));padding:8px 8px 8px 16px;border-radius:20px;background:rgba(20,20,19,.92);color:#fff;font:14px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.28);pointer-events:auto}
.say{flex:1;word-break:break-word}
button{all:unset;box-sizing:border-box;padding:6px 14px;border-radius:99px;background:#fff;color:#141413;font-weight:600;cursor:pointer;white-space:nowrap}
button:focus-visible{outline:2px solid #0a84ff;outline-offset:2px}
</style><div class="cap" role="status"><span class="say"></span><button type="button">知道了</button></div>`;
  root.querySelector(".say")!.textContent = `${location.host} · 「${label.trim()}」 这一步要你自己点`;

  const target = document.elementFromPoint(x, y);
  const button = target?.closest('button,[role="button"],input[type="submit"],input[type="button"],a') ?? target;

  if (button) {
    const r = button.getBoundingClientRect();
    const ring = document.createElement("div");
    ring.className = "ring";
    ring.style.cssText = `left:${r.left - 5}px;top:${r.top - 5}px;width:${r.width + 4}px;height:${r.height + 4}px`;
    root.prepend(ring);
  }

  root.querySelector("button")!.addEventListener("click", () => host.remove());
  (document.body ?? document.documentElement).appendChild(host);
}

export const payStopText = (label: string) =>
  `Stopped before payment: the extension does not click payment buttons, so it did not click "${label.trim()}" and the site received nothing. ` +
  "The user must click this button themselves. Do not try another way: do not press Enter, do not click another button, do not use browser_run or a script. " +
  "If the page shows the amount, the merchant or the payment method, tell the user; then stop.";

export async function showPayStopOnPage(tabId: number, label: string, x: number, y: number): Promise<void> {
  await bringForwardForUser(tabId, "pay_stop");

  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "ISOLATED", func: showPayStop, args: [OVERLAY_ATTR, OVERLAY_KIND_PAY_STOP, label, x, y] });
  } catch {  }
}

export async function stopBeforePay(tabId: number, label: string, x: number, y: number): Promise<never> {
  await showPayStopOnPage(tabId, label, x, y);

  throw Object.assign(new Error(payStopText(label)), { executionFact: "not_executed" as const, heldReason: "pay" satisfies HeldReason });
}
