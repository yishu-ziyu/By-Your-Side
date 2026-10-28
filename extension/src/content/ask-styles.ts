/** 划词：一张纸卡从工具条长成输入框、再长成回答，和侧栏同一套色阶，层级只靠字的明暗。 */
export const ASK_STYLES = `
:host {
  all: initial;
  color-scheme: light;
  --ink: #fbfcfe;
  --ink-raised: #f1f4f9;
  --ink-hover: #e9eef7;
  --ink-fg: #111827;
  --ink-fg-2: #3d4a5c;
  --ink-mute: #5a6778;
  --ink-rule: rgb(15 23 42 / .08);
  --ring: rgb(15 23 42 / .09);
  --pen: #2d4a86;
  --pen-soft: rgba(45, 74, 134, .3);
  --on-pen: #fff;
  --warn: #b74536;
  --shadow: 0 0 0 1px var(--ring), 0 12px 32px -6px rgba(15, 23, 42, .12), 0 2px 6px rgba(15, 23, 42, .04);
  --shadow-bar: 0 0 0 1px var(--ring), 0 4px 16px rgb(12 13 25 / .08), 0 2px 8px -4px rgb(12 13 25 / .12), 0 8px 32px 8px rgb(12 13 25 / .04);
  --r-outer: 14px;
  --r-inner: 9px;
  --r-small: 6px;
  --t-body: 15px;
  --t-ui: 13px;
  --t-meta: 12px;
  --t-tiny: 11.5px;
  --ease-out: cubic-bezier(.22, 1, .36, 1);
  --ease-spring: cubic-bezier(.34, 1.36, .64, 1);
  /* 和网页上那段字的黄色标记同一种黄：卡里的引用和页面上的标记一眼对得上。 */
  --mark: rgba(232, 180, 30, .9);
}
/* 卡片和侧栏用同一套色阶：设置里换「暖纸」，两边一起换。 */
:host([data-tone="warm"]) {
  --ink: oklch(0.996 0.0015 88);
  --ink-raised: oklch(0.975 0.004 88);
  --ink-hover: oklch(0.962 0.0055 88);
  --ink-fg: #141413;
  --ink-fg-2: #4a4944;
  --ink-mute: #5c5a52;
  --ink-rule: rgb(20 20 19 / .08);
  --ring: rgb(20 20 19 / .09);
  --shadow: 0 0 0 1px var(--ring), 0 12px 32px -6px rgba(20, 20, 19, .12), 0 2px 6px rgba(20, 20, 19, .04);
}
@media (prefers-color-scheme: dark) {
  :host {
    color-scheme: dark;
    --ink: #1b2332;
    --ink-raised: #161d2a;
    --ink-hover: #2b374f;
    --ink-fg: #e6ecf5;
    --ink-fg-2: #a9b6ca;
    --ink-mute: #8896ab;
    --ink-rule: rgb(255 255 255 / .08);
    --ring: rgb(255 255 255 / .1);
    --pen: #7aa2f7;
    --pen-soft: rgba(122, 162, 247, .35);
    --on-pen: #0f1622;
    --warn: #eb9284;
    --shadow: 0 0 0 1px var(--ring), 0 12px 32px -6px rgba(0, 0, 0, .45), 0 2px 6px rgba(0, 0, 0, .2);
    --shadow-bar: 0 0 0 1px var(--ring), 0 4px 16px rgb(0 0 0 / .48), 0 2px 8px -4px rgb(0 0 0 / .72), 0 8px 32px 8px rgb(0 0 0 / .24);
  }
  :host([data-tone="warm"]) {
    --ink: #2b2822;
    --ink-raised: #24211c;
    --ink-hover: #3a352c;
    --ink-fg: #eee9df;
    --ink-fg-2: #bbb3a5;
    --ink-mute: #a69d8f;
    --ink-rule: rgb(255 255 255 / .08);
    --ring: rgb(255 255 255 / .1);
    --pen: #d6aa83;
    --pen-soft: rgba(214, 170, 131, .35);
    --on-pen: #1d1b18;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.surface, .menu, .restore, .reader { font: var(--t-ui)/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif; color: var(--ink-fg); -webkit-font-smoothing: antialiased; }
.surface { position: fixed; pointer-events: auto; padding: 0; background: var(--ink); border-radius: var(--r-outer); box-shadow: var(--shadow); max-width: calc(100vw - 24px); }
.surface:not(.expanded) { padding: 2px; border-radius: 8px; box-shadow: var(--shadow-bar); }
.surface.expanded { width: 380px; display: flex; flex-direction: column; max-height: calc(100vh - 24px); overflow: hidden; border: 1px solid var(--ink-rule); }
.surface.composing { width: 420px; }
button, textarea { font: inherit; color: inherit; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex-shrink: 0; height: 32px; padding: 0 12px; border: 0; border-radius: var(--r-inner); background: transparent; cursor: pointer; white-space: nowrap; transition: background-color .15s, color .15s, transform .15s var(--ease-out); }
button:active:not(:disabled) { transform: scale(.95); }
button:disabled { opacity: .35; cursor: default; }
button:focus-visible, summary:focus-visible { outline: 2px solid var(--pen); outline-offset: -2px; }
textarea:focus-visible { outline: none; }
@media (hover: hover) and (pointer: fine) { button:not(:disabled):hover { background: var(--ink-hover); } }
button svg { width: 15px; height: 15px; stroke-width: 1.9; color: var(--ink-mute); transition: color .15s; }
button:hover svg { color: var(--ink-fg); }
button.icon { width: 32px; padding: 0; }
button.icon.small { width: 24px; height: 24px; border-radius: var(--r-small); }
button.icon.small svg { width: 14px; height: 14px; stroke-width: 1.8; }

.bar { display: flex; align-items: center; gap: 4px; min-width: 0; }
.bar button { width: 26px; height: 26px; padding: 0; border-radius: 8px; }
.bar button svg { width: 16px; height: 16px; stroke-width: 1.75; color: var(--ink-fg); }
.bar .ask svg { color: var(--pen); stroke-width: 2; }
.bar .dismiss svg { color: var(--ink-mute); }
.sep { width: 1px; height: 16px; margin: 0; background: var(--ink-rule); flex: none; }
.bar .more[aria-expanded="true"] { background: var(--ink-hover); }
.bar-tip { position: fixed; z-index: 2147483646; max-width: min(180px, calc(100vw - 16px)); padding: 5px 8px; border-radius: 7px; background: #151a20; color: #fff; box-shadow: 0 8px 22px rgb(10 14 18 / .24); font-size: 11px; font-weight: 500; line-height: 1.2; letter-spacing: .01em; white-space: nowrap; pointer-events: none; animation: tip-in .12s var(--ease-out); }
.bar-tip:after { content: ""; position: absolute; left: var(--tip-x, 50%); width: 7px; height: 7px; background: #151a20; transform: translateX(-50%) rotate(45deg); }
.bar-tip[data-side="top"]:after { bottom: -3px; }
.bar-tip[data-side="bottom"]:after { top: -3px; }
@keyframes tip-in { from { opacity: 0; } }

.tail { display: none; }

/* 右下角的缩放把手放在底栏留白里，避开发送按钮；拉过之后回答区跟着变高。 */
.resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; display: none; cursor: nwse-resize; touch-action: none; }
.surface.expanded .resize { display: block; }
.resize::before { content: ""; position: absolute; right: 3px; bottom: 3px; width: 8px; height: 8px; border-right: 2px solid var(--ink-mute); border-bottom: 2px solid var(--ink-mute); border-bottom-right-radius: 2px; opacity: .32; transition: opacity .15s; }
.resize:hover::before { opacity: .75; }
@media (hover: none) { .resize::before { opacity: .55; } }

.head { display: flex; align-items: center; gap: 7px; height: 42px; padding: 0 8px 0 9px; border-bottom: 1px solid var(--ink-rule); font-size: var(--t-meta); color: var(--ink-mute); cursor: grab; user-select: none; touch-action: none; }
.surface.dragging .head { cursor: grabbing; }
.head .grip { width: 13px; height: 24px; display: flex; align-items: center; justify-content: center; flex: none; color: var(--ink-mute); opacity: .34; transition: opacity .15s; }
.head .grip svg { width: 13px; height: 13px; stroke-width: 1.7; }
.head:hover .grip { opacity: .7; }
.head-icon { display: grid; place-items: center; width: 22px; height: 22px; flex: none; border-radius: 6px; background: var(--ink-raised); color: var(--pen); }
.head-icon svg { stroke-width: 1.9; }
.head .title { flex: 1; min-width: 0; font-size: var(--t-ui); font-weight: 600; color: var(--ink-fg); }
.turn > .source { margin-bottom: 6px; padding-left: 8px; box-shadow: inset 2px 0 0 var(--mark); font-size: var(--t-meta); line-height: 1.5; color: var(--ink-fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.voice-pending .question { color: var(--ink-fg-2); }
.question svg { width: 12px; height: 12px; margin-right: 4px; vertical-align: -2px; stroke-width: 2; color: var(--ink-mute); }
.messages { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--ink-hover) transparent; padding: 15px 16px 12px; max-height: min(430px, 52vh); }
.surface.resized .messages { max-height: none; }
.turn + .turn { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--ink-rule); }
.question { font-size: var(--t-meta); line-height: 1.5; margin-bottom: 6px; color: var(--ink-mute); overflow-wrap: anywhere; white-space: pre-wrap; }
.answer, .answer-summary { font-size: var(--t-body); line-height: 1.72; letter-spacing: .01em; color: var(--ink-fg); overflow-wrap: anywhere; }
.answer > :first-child { margin-top: 0; } .answer > :last-child { margin-bottom: 0; }
.answer p { margin: 8px 0; }
.answer h1, .answer h2, .answer h3 { font-size: var(--t-body); line-height: 1.5; margin: 12px 0 6px; font-weight: 600; }
.answer ul, .answer ol { padding-left: 20px; margin: 6px 0; } .answer li { margin: 3px 0; }
.answer li::marker { color: var(--ink-mute); }
.answer strong { color: var(--ink-fg); font-weight: 600; }
.answer code { font: var(--t-meta)/1.6 ui-monospace, SFMono-Regular, monospace; background: var(--ink-hover); border-radius: 4px; padding: 1px 4px; }
.answer pre { background: var(--ink-raised); border-radius: var(--r-inner); padding: 10px; overflow: auto; }
.answer pre code { padding: 0; background: transparent; white-space: pre; }
.answer a { color: var(--ink-fg); text-decoration: underline; text-decoration-color: var(--pen-soft); text-underline-offset: 3px; }
.answer blockquote { margin: 8px 0; padding-left: 10px; border-left: 2px solid var(--ink-rule); color: var(--ink-fg-2); }
.answer hr { height: 1px; margin: 10px 0; border: 0; background: var(--ink-rule); }
.answer table { display: block; max-width: 100%; overflow: auto; border-collapse: collapse; font-size: var(--t-ui); } .answer td, .answer th { padding: 4px 8px; border: 1px solid var(--ink-rule); }
.meta { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 6px; margin-top: 8px; min-height: 24px; font-size: var(--t-meta); color: var(--ink-mute); }
.meta:empty { display: none; }
.meta button svg { width: 12px; height: 12px; color: var(--pen); }
.meta button { height: 24px; padding: 0 6px; margin-left: -6px; border-radius: var(--r-small); font-size: var(--t-meta); color: var(--pen); }
.meta button + button { margin-left: 0; }
.status.err { color: var(--warn); }
.tag { color: var(--ink-fg-2); }

.foot .current-source { flex: 0 1 auto; min-width: 0; max-width: 46%; justify-content: flex-start; color: var(--ink-mute); font-size: var(--t-meta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.current-source svg { flex:none; }
.composer { display: flex; align-items: flex-end; gap: 3px; margin: 0 10px 10px; padding: 4px; border: 1px solid var(--ink-rule); border-radius: var(--r-inner); background: var(--ink-raised); }
button.depth { height: 28px; margin-bottom: 2px; padding: 0 7px; border: 1px solid var(--ink-rule); border-radius: 7px; background: var(--ink); font-size: var(--t-tiny); color: var(--ink-mute); }
button.depth[aria-pressed="true"] { color: var(--pen); background: var(--ink-hover); }
.foot { display: flex; align-items: center; gap: 2px; min-height: 40px; padding: 2px 10px 9px; }
.foot .grow { flex: 1; }
.foot button { height: 30px; padding: 0 8px; border-radius: 7px; font-size: var(--t-meta); color: var(--ink-fg-2); }
.foot button svg { width: 15px; height: 15px; }
.foot button.icon { width: 28px; padding: 0; color:var(--ink-mute); }
.foot .handoff { gap: 6px; padding: 0 10px; border: 1px solid var(--ink-rule); background: var(--ink-raised); color: var(--ink-fg-2); font-weight: 500; }
.foot .handoff svg { width: 14px; height: 14px; }
.pins { display: flex; min-width: 0; overflow-x: auto; scrollbar-width: none; }
textarea { resize: none; flex: 1; min-width: 0; height: 34px; max-height: 100px; padding: 7px 6px 6px; border: 0; background: transparent; outline: none; line-height: 20px; font-size: 14px; color: var(--ink-fg); }
textarea::placeholder { color: var(--ink-mute); }
button.send { width: 32px; padding: 0; border-radius: 50%; background: var(--pen); }
button.send svg { color: var(--on-pen); width: 15px; height: 15px; stroke-width: 2; }
@media (hover: hover) and (pointer: fine) { button.send:not(:disabled):hover { background: var(--pen); filter: brightness(1.1); } }
.chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 0 10px 10px; padding: 0; overflow: visible; }
.chips button { height: 29px; padding: 0 10px; border: 1px solid var(--ink-rule); border-radius: 999px; background: var(--ink); font-size: var(--t-meta); color: var(--ink-fg-2); }
.chips button:hover { color: var(--ink-fg); }
.error { font-size: var(--t-meta); color: var(--warn); padding: 4px 12px 6px; overflow-wrap: anywhere; }
.error.info { color: var(--ink-mute); }

.menu { position: fixed; pointer-events: auto; width: 248px; padding: 5px; border: 1px solid var(--ink-rule); background: var(--ink); border-radius: var(--r-outer); box-shadow: var(--shadow); display: flex; flex-direction: column; animation: pop-in .18s var(--ease-out); }
.menu button { justify-content: flex-start; width: 100%; height: 36px; padding: 0 9px; border-radius: 8px; }
.menu button.dim { color: var(--ink-mute); }
.menu button.dim:hover { color: var(--ink-fg); }
.menu-label { padding: 6px 9px 3px; font-size: var(--t-tiny); color: var(--ink-mute); }
.menu-row { display: flex; align-items: center; }
.menu-row button[data-prompt] { flex: 1; }
.menu-glyph { display: grid; place-items: center; width: 18px; height: 18px; margin-right: 2px; color: var(--ink-mute); }
.menu-glyph svg { width: 15px; height: 15px; stroke-width: 1.75; }
.menu .pin { width: 28px; padding: 0; justify-content: center; opacity: 0; }
.menu-row:hover .pin, .menu .pin:focus-visible, .menu .pin[aria-pressed="true"] { opacity: 1; }
.menu .pin[aria-pressed="true"] svg { color: var(--pen); fill: var(--pen-soft); }
.menu .menu-action { gap: 8px; }
.menu-action-icon { display: grid; place-items: center; width: 18px; color: var(--ink-mute); }
.menu-action-icon svg { width: 15px; height: 15px; }
.menu .rule { height: 1px; margin: 4px 6px; background: var(--ink-rule); }

.restore { position: fixed; right: 18px; bottom: 18px; pointer-events: auto; height: 36px; padding: 0 14px; background: var(--ink); color: var(--ink-fg); border-radius: 999px; box-shadow: var(--shadow); }
@media (hover: hover) and (pointer: fine) { .restore:hover { background: var(--ink); } }

.surface { transition: opacity .2s var(--ease-out); }
/* 读者在滚正文：浮在正文上的卡片淡下去让开，停下就回来，不收起、不改内容。 */
.surface.receding { opacity: .28; transition-duration: .12s; }
.surface.glide { transition: left .28s var(--ease-out), top .28s var(--ease-out), opacity .2s var(--ease-out); }
.surface.enter { animation: lens-in .24s var(--ease-spring); transform-origin: var(--origin, bottom center); }
.surface.morph { animation: lens-morph .24s var(--ease-out); transform-origin: var(--origin, bottom center); }
@keyframes lens-in { from { opacity: 0; transform: translateY(4px) scale(.96); } to { opacity: 1; transform: none; } }
@keyframes lens-morph { from { opacity: .6; transform: scale(.97); } to { opacity: 1; transform: none; } }
@keyframes pop-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }

.reader { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; align-items: center; gap: 2px; padding: 4px; max-width: calc(100vw - 24px); background: var(--ink); border-radius: 999px; box-shadow: var(--shadow); pointer-events: auto; animation: reader-enter .16s var(--ease-out); }
.reader button { border-radius: 999px; }
.reader-label { padding: 0 8px; color: var(--ink-fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.reader-rate { min-width: 46px; font-variant-numeric: tabular-nums; color: var(--ink-fg-2); }
@keyframes reader-enter { from { opacity: 0; transform: translateX(-50%) translateY(4px); } to { opacity: 1; transform: translateX(-50%); } }
@media (prefers-reduced-motion: reduce) { .surface.enter, .surface.morph, .menu, .reader, .bar-tip { animation: none; } button, .surface, .surface.glide { transition: none; } }
`;
