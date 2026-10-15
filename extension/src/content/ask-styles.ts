/** A single anchored surface; typography stays stable while its contents stream. */
export const ASK_STYLES = `
:host { all: initial; color-scheme: light; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.surface, .restore, .reader { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; color: #232326; -webkit-font-smoothing: antialiased; }
.surface { position: fixed; pointer-events: auto; width: 286px; max-width: calc(100vw - 24px); border: 1px solid #e6e6e8; border-radius: 7px; background: #fffffc; box-shadow: 0 3px 12px #212a2410; overflow: hidden; }
.surface.expanded { width: 320px; border-radius: 8px; display: flex; flex-direction: column; max-height: calc(100vh - 24px); }
button, textarea { font: inherit; color: inherit; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; border: 0; background: transparent; cursor: pointer; min-height: 36px; border-radius: 18px; padding: 0 10px; flex-shrink: 0; }
button:not(:disabled) { transition: transform 140ms cubic-bezier(.23,1,.32,1), background-color 140ms cubic-bezier(.23,1,.32,1); }
button:active:not(:disabled) { transform: scale(.96); }
button:disabled { opacity: .4; cursor: default; }
button:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid #5181d9; outline-offset: -2px; }
button svg { width: 16px; height: 16px; stroke-width: 1.7; }
button.icon { width: 36px; padding: 0; }
@media (hover: hover) and (pointer: fine) { button:not(:disabled):hover { background: #f1f1f3; } }
.bar { display: flex; align-items: center; padding: 3px 5px; gap: 0; }
.bar button { font-size: 12px; min-height: 30px; border-radius: 4px; }
.bar .identity, .header .identity { display: none; }
.bar .ask { font-weight: 550; flex: 1; }
.bar .explain { color: #626268; border-left: 1px solid #ededf0; border-radius: 0; }
.identity { color: #5779bf; display: inline-flex; align-items: center; }
.header { display: flex; align-items: center; gap: 7px; padding: 7px 8px 0 17px; }
.site { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #78787e; font-size: 11px; }
.header .icon { width: 28px; min-height: 28px; border-radius: 4px; }
.quote { margin: 0 17px 10px; font-size: 12px; color: #77777d; }
.quote summary { cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; list-style: none; }
.quote[open] summary { white-space: normal; }
.quote p { margin: 6px 0; max-height: 110px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: #55555c; }
.limit { color: #936b2a; font-size: 11px; padding-top: 4px; }
.messages { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; padding: 0 17px; max-height: min(380px, 48vh); }
.turn { padding: 12px 0 16px; border-top: 1px solid #eeeef0; }
.question { font-size: 12px; font-weight: 550; line-height: 1.55; margin-bottom: 10px; color: #5e5e66; overflow-wrap: anywhere; white-space: pre-wrap; }
.answer, .answer-summary { font-size: 15px; line-height: 1.8; color: #30382c; overflow-wrap: anywhere; }
.answer > :first-child { margin-top: 0; } .answer > :last-child { margin-bottom: 0; }
.answer p { margin: 9px 0; }
.answer > p.lead { font-weight: 450; color: inherit; }
.answer h1,.answer h2,.answer h3 { font-size: 15px; line-height: 1.5; margin: 14px 0 7px; }
.answer ul,.answer ol { padding-left: 21px; margin: 8px 0; } .answer li { margin: 4px 0; }
.answer code { font: 12px/1.65 ui-monospace, SFMono-Regular, monospace; background: #f4f4f6; border-radius: 4px; padding: 1px 3px; }
.answer pre { background: #f5f5f7; border: 1px solid #ececef; border-radius: 10px; padding: 10px; overflow: auto; }
.answer pre code { padding: 0; background: transparent; white-space: pre; }
.answer a { color: #416ab0; text-decoration: underline; text-underline-offset: 3px; }
.answer blockquote { border-left: 2px solid #d9dde7; margin: 8px 0; padding-left: 10px; color: #707078; }
.answer table { display: block; max-width: 100%; overflow: auto; border-collapse: collapse; } .answer td,.answer th { padding: 5px 8px; border: 1px solid #e8e8eb; }
.status { display: flex; align-items: center; gap: 5px; color: #888890; font-size: 12px; min-height: 24px; }
.status:empty { display: none; }
.turn.folded .answer { max-height: 3.4em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 40%, transparent); mask-image: linear-gradient(#000 40%, transparent); }
.foot { display: flex; align-items: center; gap: 5px; }
.details { display: flex; min-height: 30px; padding: 0; border-radius: 4px; font-size: 11px; color: #536b51; }
.fold { font-size: 11px; color: #5779bf; min-height: 22px; padding: 0 6px; margin-left: -6px; }
.tag { display: inline-block; font-size: 11px; color: #b4532a; background: #fbeee8; border-radius: 4px; padding: 0 5px; margin-left: 6px; font-weight: 500; }
.composer { display: flex; gap: 6px; align-items: flex-end; margin: 0 14px 8px; padding: 8px 0 0; border: 0; border-top: 1px solid #e2e5dc; border-radius: 0; background: transparent; flex-wrap: wrap; }
.depth { display: flex; flex: none; order: 3; width: 100%; align-self: center; gap: 4px; }
.depth button { min-height: 24px; padding: 0 5px; border-radius: 3px; font-size: 11px; color: #6e6e76; }
.depth button[aria-checked="true"] { background: #eef1e8; color: #232326; font-weight: 500; }
.link { position: fixed; z-index: 1; height: 1px; margin-top: 0; background: #8ea4cc; pointer-events: none; }
.link::before { content: ""; position: absolute; left: -2.5px; top: -2.5px; width: 5px; height: 5px; border-radius: 50%; background: #8ea4cc; }
textarea { resize: none; width: 100%; flex: 1; min-width: 0; min-height: 34px; max-height: 100px; padding: 7px 0; border: 0; background: transparent; outline: none; line-height: 20px; }
textarea::placeholder { color: #919198; }
button.send { color: white; background: #36483b; width: 30px; min-height: 30px; padding: 0; border-radius: 5px; }
@media (hover: hover) and (pointer: fine) { button.send:not(:disabled):hover { background: #424249; } }
.footer { display: flex; justify-content: flex-start; align-items: center; padding: 5px 8px 5px 11px; gap: 0; border-top: 1px solid #edf0e8; color: #797981; font-size: 11px; }
.footer button { font-size: 11px; min-height: 30px; border-radius: 4px; }
.footer [data-act="copy"] { margin-left: auto; }
.footer [data-act="copy"], .footer [data-act="handoff"] { width: 30px; font-size: 0; gap: 0; padding: 0; }
.footer svg { width: 14px; height: 14px; }
.error { font-size: 12px; color: #925240; padding: 0 16px 8px; overflow-wrap: anywhere; }
.error.info { color: #77777d; }
.restore { position: fixed; right: 18px; bottom: 18px; border: 1px solid #e5e5e8; background: #fff; border-radius: 22px; box-shadow: 0 4px 18px #17171a14; padding: 0 14px; pointer-events: auto; }
.surface.enter { animation: reading-enter 160ms cubic-bezier(.23,1,.32,1); }
@keyframes reading-enter { from { opacity: 0; transform: translateY(3px) scale(.95); } to { opacity: 1; transform: none; } }
.reader { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; align-items: center; gap: 2px; padding: 4px; max-width: calc(100vw - 24px); border: 1px solid #e6e6e8; border-radius: 22px; background: #fff; box-shadow: 0 3px 8px #17171a08, 0 12px 32px #17171a12; pointer-events: auto; animation: reader-enter 160ms cubic-bezier(.23,1,.32,1); }
.reader-label { padding: 0 8px; color: #626268; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.reader-rate { min-width: 46px; font-variant-numeric: tabular-nums; color: #626268; }
@keyframes reader-enter { from { opacity: 0; transform: translateX(-50%) translateY(4px); } to { opacity: 1; transform: translateX(-50%); } }
@media (prefers-reduced-motion: reduce) { .surface.enter, .reader { animation: none; } button { transition: none; } }
`;
