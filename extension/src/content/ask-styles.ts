/** 划词：一块墨色从工具条长成输入框、再长成回答，同一种材质，层级只靠字的明暗。 */
export const ASK_STYLES = `
:host {
  all: initial;
  color-scheme: light;
  --ink: #141518;
  --ink-raised: #1f2025;
  --ink-hover: #2c2e33;
  --ink-fg: #f5f5f4;
  --ink-fg-2: #c9cacd;
  --ink-mute: #8e9096;
  --ink-rule: rgba(142, 144, 150, .22);
  --pen: #4f7be0;
  --pen-soft: rgba(79, 123, 224, .35);
  --warn: #e7a08a;
  --shadow: 0 1px 1px rgba(15, 20, 30, .04), 0 14px 36px -14px rgba(15, 20, 30, .32), 0 3px 8px -3px rgba(15, 20, 30, .1);
  --r-outer: 14px;
  --r-inner: 10px;
  --r-small: 6px;
  --t-body: 14.5px;
  --t-ui: 13px;
  --t-meta: 12px;
  --t-tiny: 11.5px;
  --ease-out: cubic-bezier(.22, 1, .36, 1);
  --ease-spring: cubic-bezier(.34, 1.36, .64, 1);
}
:host([data-tone="warm"]) {
  --ink: #1d1b18;
  --ink-raised: #282520;
  --ink-hover: #34312c;
  --ink-fg: #f3efe6;
  --ink-fg-2: #cfc8bb;
  --ink-mute: #9a9285;
  --ink-rule: rgba(154, 146, 133, .22);
  --pen: #c1401b;
  --pen-soft: rgba(193, 64, 27, .4);
  --shadow: 0 1px 1px rgba(40, 30, 20, .04), 0 14px 36px -14px rgba(40, 30, 20, .3), 0 3px 8px -3px rgba(40, 30, 20, .1);
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.surface, .menu, .restore, .reader { font: var(--t-ui)/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif; color: var(--ink-fg); -webkit-font-smoothing: antialiased; }
.surface { position: fixed; pointer-events: auto; padding: 4px; background: var(--ink); border-radius: var(--r-outer); box-shadow: var(--shadow); max-width: calc(100vw - 24px); }
.surface.expanded { width: 340px; display: flex; flex-direction: column; max-height: calc(100vh - 24px); }
.surface.composing { width: 440px; }
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

.bar { display: flex; align-items: center; gap: 2px; }
.bar .ask { font-weight: 500; gap: 8px; background: var(--ink-hover); }
.caret { width: 1.5px; height: 14px; border-radius: 2px; background: var(--pen); animation: caret-pulse 1.05s ease-in-out infinite; }
.sep { width: 1px; height: 16px; margin: 0 3px; background: var(--ink-rule); flex: none; }
.bar .more[aria-expanded="true"] { background: var(--ink-hover); }

.tail { position: absolute; left: var(--tail-x, 50%); width: 0; height: 0; margin-left: -7px; border-left: 7px solid transparent; border-right: 7px solid transparent; pointer-events: none; }
.surface[data-tail="down"] .tail { top: 100%; border-top: 7px solid var(--ink); }
.surface[data-tail="up"] .tail { bottom: 100%; border-bottom: 7px solid var(--ink); }
.surface:not([data-tail]) .tail { display: none; }

.head { display: flex; align-items: center; gap: 4px; height: 28px; padding: 4px 4px 0 12px; font-size: var(--t-meta); color: var(--ink-mute); }
.head .q { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.head .quote { color: var(--ink-fg-2); }
.question svg { width: 12px; height: 12px; margin-right: 4px; vertical-align: -2px; stroke-width: 2; color: var(--ink-mute); }
.messages { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--ink-hover) transparent; padding: 4px 12px 10px; max-height: min(420px, 52vh); }
.turn + .turn { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--ink-rule); }
.question { font-size: var(--t-meta); line-height: 1.5; margin-bottom: 6px; color: var(--ink-mute); overflow-wrap: anywhere; white-space: pre-wrap; }
.answer, .answer-summary { font-size: var(--t-body); line-height: 1.6; color: var(--ink-fg); overflow-wrap: anywhere; }
.answer > :first-child { margin-top: 0; } .answer > :last-child { margin-bottom: 0; }
.answer p { margin: 8px 0; }
.answer h1, .answer h2, .answer h3 { font-size: var(--t-body); line-height: 1.5; margin: 12px 0 6px; }
.answer ul, .answer ol { padding-left: 20px; margin: 6px 0; } .answer li { margin: 3px 0; }
.answer li::marker { color: var(--ink-mute); }
.answer strong { color: var(--ink-fg); font-weight: 600; }
.answer code { font: var(--t-meta)/1.6 ui-monospace, SFMono-Regular, monospace; background: var(--ink-hover); border-radius: 4px; padding: 1px 4px; }
.answer pre { background: var(--ink-raised); border-radius: var(--r-inner); padding: 10px; overflow: auto; }
.answer pre code { padding: 0; background: transparent; white-space: pre; }
.answer a { color: var(--ink-fg); text-decoration: underline; text-decoration-color: var(--pen-soft); text-underline-offset: 3px; }
.answer blockquote { margin: 8px 0; padding-left: 10px; border-left: 2px solid var(--ink-rule); color: var(--ink-fg-2); }
.answer table { display: block; max-width: 100%; overflow: auto; border-collapse: collapse; font-size: var(--t-ui); } .answer td, .answer th { padding: 4px 8px; border: 1px solid var(--ink-rule); }
.meta { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 6px; margin-top: 8px; min-height: 24px; font-size: var(--t-meta); color: var(--ink-mute); }
.meta:empty { display: none; }
.meta .dot { opacity: .5; }
.meta button { height: 24px; padding: 0 6px; margin-left: -6px; border-radius: var(--r-small); font-size: var(--t-meta); color: var(--ink-fg-2); }
.meta button + button { margin-left: 0; }
.status.err { color: var(--warn); }
.tag { color: var(--ink-fg-2); }

.composer { display: flex; align-items: flex-end; gap: 6px; padding-left: 12px; }
.surface.expanded:not(.composing) .composer { border-top: 1px solid var(--ink-rule); padding-top: 4px; }
textarea { resize: none; flex: 1; min-width: 0; height: 32px; max-height: 100px; padding: 6px 0; border: 0; background: transparent; outline: none; line-height: 20px; font-size: 14px; color: var(--ink-fg); }
textarea::placeholder { color: var(--ink-mute); }
button.send { width: 32px; padding: 0; background: var(--pen); }
button.send svg { color: #fff; width: 15px; height: 15px; stroke-width: 2; }
@media (hover: hover) and (pointer: fine) { button.send:not(:disabled):hover { background: var(--pen); filter: brightness(1.1); } }
.chips { display: flex; gap: 2px; margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--ink-rule); overflow-x: auto; scrollbar-width: none; }
.chips button { height: 28px; padding: 0 10px; border-radius: 9px; font-size: 12.5px; color: var(--ink-mute); }
.chips button:hover { color: var(--ink-fg); }
.error { font-size: var(--t-meta); color: var(--warn); padding: 4px 12px 6px; overflow-wrap: anywhere; }
.error.info { color: var(--ink-mute); }

.menu { position: fixed; pointer-events: auto; width: 200px; padding: 4px; background: var(--ink); border-radius: var(--r-outer); box-shadow: var(--shadow); display: flex; flex-direction: column; animation: pop-in .18s var(--ease-out); }
.menu button { justify-content: flex-start; width: 100%; padding: 0 10px; }
.menu button.dim { color: var(--ink-mute); }
.menu button.dim:hover { color: var(--ink-fg); }
.menu .rule { height: 1px; margin: 4px 6px; background: var(--ink-rule); }

.restore { position: fixed; right: 18px; bottom: 18px; pointer-events: auto; height: 36px; padding: 0 14px; background: var(--ink); color: var(--ink-fg); border-radius: 999px; box-shadow: var(--shadow); }
@media (hover: hover) and (pointer: fine) { .restore:hover { background: var(--ink); } }

.surface.enter { animation: lens-in .24s var(--ease-spring); transform-origin: var(--origin, bottom center); }
.surface.morph { animation: lens-morph .24s var(--ease-out); transform-origin: var(--origin, bottom center); }
@keyframes lens-in { from { opacity: 0; transform: translateY(4px) scale(.96); } to { opacity: 1; transform: none; } }
@keyframes lens-morph { from { opacity: .6; transform: scale(.97); } to { opacity: 1; transform: none; } }
@keyframes pop-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
@keyframes caret-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .15; } }

.reader { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; align-items: center; gap: 2px; padding: 4px; max-width: calc(100vw - 24px); background: var(--ink); border-radius: 999px; box-shadow: var(--shadow); pointer-events: auto; animation: reader-enter .16s var(--ease-out); }
.reader button { border-radius: 999px; }
.reader-label { padding: 0 8px; color: var(--ink-fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.reader-rate { min-width: 46px; font-variant-numeric: tabular-nums; color: var(--ink-fg-2); }
@keyframes reader-enter { from { opacity: 0; transform: translateX(-50%) translateY(4px); } to { opacity: 1; transform: translateX(-50%); } }
@media (prefers-reduced-motion: reduce) { .surface.enter, .surface.morph, .menu, .reader, .caret { animation: none; } button { transition: none; } }
`;
