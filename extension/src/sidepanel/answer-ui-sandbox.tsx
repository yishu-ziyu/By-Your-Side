import { Renderer, type ActionEvent, type OpenUIError } from "@openuidev/react-lang";
import { createRoot } from "react-dom/client";
import { runLibraryAction } from "../vendor/openui/lib/actions";
import { library } from "../vendor/openui/lib/library";

type Program = { html: string; state: string | null; maxHeight?: number };

const post = (kind: string, data: Record<string, unknown> = {}) => parent.postMessage({ miniApp: kind, ...data }, "*");

const CONTEXT_MAX = 2000;

function valueText(value: unknown): string {
  const inner = value && typeof value === "object" && "value" in value ? (value as { value: unknown }).value : value;

  return typeof inner === "string" ? inner : JSON.stringify(inner);
}

function sendText(event: ActionEvent): string {
  const context = event.params.context;
  const entries = Object.entries({ ...(event.formState ?? {}), ...(context === undefined ? {} : { context }) });
  const detail = entries.map(([name, value]) => `${name.replace(/^\$/, "")}：${valueText(value)}`).join("；").slice(0, CONTEXT_MAX);

  return detail ? `${event.humanFriendlyMessage}（当前 ${detail}）` : event.humanFriendlyMessage;
}

function onAction(event: ActionEvent): void {
  if (event.type === "continue_conversation") post("send", { text: sendText(event) });
  else if (event.type === "open_url") post("open", { url: event.params.url });
  else void runLibraryAction(event);
}

let failed = false;

function onError(errors: OpenUIError[]): void {
  const first = errors.find((error) => (error as { severity?: string }).severity !== "warning");

  if (!first || failed) return;
  failed = true;
  post("error", { message: String(first.message).slice(0, 300) });
}

function parseState(state: string | null): Record<string, unknown> | undefined {
  try {
    return state === null ? undefined : JSON.parse(state) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function saveState(state: Record<string, unknown>): void {
  const text = JSON.stringify(state);

  if (text.length <= 50_000) post("save", { state: text });
}

function watchHeight(maxHeight: number): void {
  const height = () => {
    const h = Math.ceil(document.body.getBoundingClientRect().height);

    document.documentElement.style.overflowY = h <= maxHeight ? "hidden" : "auto";
    post("height", { h });
  };

  new ResizeObserver(height).observe(document.body);
  height();
}

function followTheme(): void {
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => document.documentElement.setAttribute("data-openui-theme", dark.matches ? "dark" : "light");

  apply();
  dark.addEventListener("change", apply);
}

let started = false;

addEventListener("message", (event: MessageEvent<Program>) => {
  if (event.source !== parent || started || typeof event.data?.html !== "string") return;
  started = true;
  followTheme();
  createRoot(document.getElementById("root")!).render(<Renderer response={event.data.html} library={library} onAction={onAction} onError={onError} onStateUpdate={saveState} initialState={parseState(event.data.state)} />);
  watchHeight(event.data.maxHeight ?? 720);
});

// WHY: 浏览器在布局来不及跟上时会报这条，界面其实正常；当成出错会让用户看到假的故障。
const BENIGN_ERROR = /^ResizeObserver loop/;

addEventListener("error", (event) => { if (!failed && !BENIGN_ERROR.test(event.message)) { failed = true; post("error", { message: String(event.message).slice(0, 300) }); } });

// WHY: 沙箱不许弹窗，链接点了没反应；只能交给侧栏开标签页，由侧栏查用户是否真的点了。
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;

  if (!link) return;
  event.preventDefault();
  post("open", { url: link.href });
}, true);

post("ready");
