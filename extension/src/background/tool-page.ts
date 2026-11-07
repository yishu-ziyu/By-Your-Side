import { sendCommand } from "./debugger.js";
import { fetchUrl } from "./exec/fetch-url.js";
import { videoCaptions } from "./exec/video-captions.js";
import { parseTimedCaptions, pickCaptionTrack } from "../../../shared/timed-captions.js";
import { TOOL_PAGE_MESSAGE, type ToolCaptionsReply, type ToolPageRequest } from "../../../shared/saved-tools.js";
import { readCurrentDocument } from "./exec/page-readiness.js";

const MAX_CUES = 5000;

const READ_LOADED_CUES = `(() => {
  for (const video of document.querySelectorAll("video")) for (const track of video.textTracks) {
    const cues = track.cues ? [...track.cues] : [];
    if (cues.length) return { language: track.language || "", cues: cues.map(cue => ({ start: cue.startTime, end: cue.endTime, text: cue.text })) };
  }
  return null;
})()`;

const empty = (status: ToolCaptionsReply["status"], message: string, title = ""): ToolCaptionsReply => ({ status, message, title, language: "", automatic: false, cues: [] });

async function evaluate(tabId: number, expression: string): Promise<unknown> {
  const reply = await sendCommand<{ result?: { value?: unknown } }>(tabId, "Runtime.evaluate", { expression, returnByValue: true }, undefined, 15_000);

  return reply.result?.value;
}

const clean = (cues: ToolCaptionsReply["cues"]) => cues.flatMap(cue => {
  const text = cue.text.trim();

  return text ? [{ start: cue.start, end: cue.end, text }] : [];
}).slice(0, MAX_CUES);

async function captions(tabId: number): Promise<ToolCaptionsReply> {
  const found = await videoCaptions({ tabId });
  const title = found.title ?? "";
  const tracks = (found.captionTracks ?? []) as Array<{ lang: string; auto: boolean; url?: string }>;
  const track = pickCaptionTrack(tracks, chrome.i18n.getUILanguage());

  const loaded = await evaluate(tabId, READ_LOADED_CUES) as { language: string; cues: ToolCaptionsReply["cues"] } | null | undefined;

  if (loaded?.cues?.length) return { status: "ok", message: "", title, language: loaded.language, automatic: false, cues: clean(loaded.cues) };

  if (track?.url) {
    const body = await fetchUrl({ url: track.url, method: "GET" }).catch(() => null) as { ok?: boolean; text?: string } | null;
    const parsed = body?.ok === true && typeof body.text === "string" ? parseTimedCaptions(body.text) : null;

    if (parsed) return { status: "ok", message: "", title, language: track.lang, automatic: track.auto, cues: clean(parsed.cues) };

    return empty("unavailable", "网站这次没有给出字幕内容。打开视频自己的字幕（CC）后再试一次。", title);
  }

  if (found.loginRequired) return empty("login", "这个网站要登录后才提供字幕，登录后再试一次。", title);

  if (found.lists > 0) return empty("none", "这个视频没有可用字幕。", title);

  return empty("unavailable", "这次没有读到这个页面的视频字幕。", title);
}

const MAX_PAGE_TEXT = 200_000;
const MAX_SECTIONS = 500;

const HEADINGS = "h1, h2, h3, h4";

async function inPage<Args extends unknown[], Result>(tabId: number, documentId: string, func: (...args: Args) => Result, args: Args): Promise<Result | undefined> {
  const [frame] = await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, func: func as (...args: unknown[]) => unknown, args });

  return frame?.result as Result | undefined;
}

export function registerToolPage(isPanel: (sender: chrome.runtime.MessageSender) => boolean): void {
  chrome.runtime.onMessage.addListener((raw: unknown, sender, respond) => {
    const message = raw as Partial<ToolPageRequest> | undefined;

    if (message?.type !== TOOL_PAGE_MESSAGE || !isPanel(sender) || !Number.isInteger(message.tabId)) return;
    const tabId = message.tabId!;

    void (async () => {
      const current = await readCurrentDocument(tabId);
      if (!current || current.documentId !== message.documentId || current.url !== message.url) throw new Error("页面已经换了");
      if (message.action === "captions") {
        const value = await captions(tabId);
        if ((await readCurrentDocument(tabId))?.documentId !== current.documentId) throw new Error("页面已经换了");
        respond({ ok: true, value });

        return;
      }

      if (message.action === "read") {
        const value = await inPage(tabId, current.documentId, (selector: string, maxText: number, maxSections: number) => ({
          title: document.title,
          text: (document.body?.innerText ?? "").slice(0, maxText),
          sections: [...document.querySelectorAll<HTMLElement>(selector)].filter(el => el.innerText?.trim() && el.getClientRects().length > 0).slice(0, maxSections).map((el, index) => ({ index, level: Number(el.tagName[1]), text: el.innerText.trim().slice(0, 200) })),
        }), [HEADINGS, MAX_PAGE_TEXT, MAX_SECTIONS]);

        if (!value) throw new Error("没有读到页面");
        respond({ ok: true, value });

        return;
      }

      if (message.action === "jump") {
        if (!Number.isInteger(message.section) || message.section! < 0) throw new Error("请求无效");
        const moved = await inPage(tabId, current.documentId, (selector: string, section: number) => {
          // WHY: 过滤条件要和读取时一模一样，序号才对得上；注入页面的函数不能引用外面的变量。
          const el = [...document.querySelectorAll<HTMLElement>(selector)].filter(item => item.innerText?.trim() && item.getClientRects().length > 0)[section];
          if (!el) return false;
          el.scrollIntoView({ block: "start" });
          return true;
        }, [HEADINGS, message.section!]);

        if (!moved) throw new Error("页面上没有这一节");
        respond({ ok: true, value: { section: message.section } });

        return;
      }

      if (message.action !== "seek" || !Number.isFinite(message.seconds) || message.seconds! < 0) throw new Error("请求无效");
      const tab = await chrome.tabs.get(tabId);

      if (tab.url !== message.url) throw new Error("页面已经换了");
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId, documentIds: [current.documentId] },
        func: (seconds: number) => {
          const video = [...document.querySelectorAll("video")].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
          if (!video) return null;
          video.currentTime = seconds;
          void video.play().catch(() => {});
          return video.currentTime;
        },
        args: [message.seconds!],
      });
      const time = frame?.result;

      if (typeof time !== "number") throw new Error("这个页面上没有视频");
      respond({ ok: true, value: { time } });
    })().catch((error: unknown) => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }));

    return true;
  });
}
