/**
 * `video_captions`：这一页的视频播放器自己有哪些字幕。只读，不改页面。
 * 来源只取播放器真用的：<video> 的字幕轨道、YouTube 页面里的字幕清单、页面自己发过的播放器接口
 * （原地址原样、带登录状态再取一次）。不拼接口：B 站对不带签名的 x/player/v2 每次回一份别的视频的 AI 字幕。
 */
import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { sendCommand } from "../debugger.js";
import { resolveReadableTab } from "../state.js";

interface CaptionTrack {
  source: "video" | "track" | "youtube" | "player-api";
  lang: string;
  label: string;
  auto: boolean;
  url?: string;
  cues?: number | null;
}

interface PageCaptions {
  videos: number;
  tracks: CaptionTrack[];
  /** 页面自己的播放器接口里明说的字幕清单（字段名、条数），空清单就是这个视频没有字幕。 */
  lists: Array<{ request: string; field: string; count: number }>;
  failed: string[];
}

/** 在页面里跑（主世界）：读轨道和清单，再用页面自己的登录状态重取它发过的播放器接口。 */
const READ_CAPTIONS = `(async () => {
  const out = { videos: document.querySelectorAll("video").length, tracks: [], lists: [], failed: [] };
  for (const v of document.querySelectorAll("video")) for (const t of v.textTracks) out.tracks.push({ source: "video", lang: t.language || "", label: t.label || "", auto: false, cues: t.cues ? t.cues.length : null });
  for (const el of document.querySelectorAll("video track[src]")) out.tracks.push({ source: "track", lang: el.srclang || "", label: el.label || "", auto: false, url: el.src });
  const yt = window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (Array.isArray(yt)) {
    out.lists.push({ request: "ytInitialPlayerResponse", field: "captionTracks", count: yt.length });
    for (const c of yt) out.tracks.push({ source: "youtube", lang: c.languageCode || "", label: c.name?.simpleText ?? c.name?.runs?.[0]?.text ?? "", auto: c.kind === "asr", url: c.baseUrl });
  }
  const PLAYER = /\\/x\\/player\\/(wbi\\/)?v2|\\/player\\/v\\d|timedtext|subtitle|caption/i;
  const LIST = /^(subtitles|captionTracks|captions|subtitle_list)$/i;
  const seen = new Set();
  for (const e of performance.getEntriesByType("resource")) {
    if (seen.size >= 4) break;
    if (!PLAYER.test(e.name) || seen.has(e.name) || !["xmlhttprequest", "fetch"].includes(e.initiatorType)) continue;
    seen.add(e.name);
    try {
      const r = await fetch(e.name, { credentials: "include" });
      if (!(r.headers.get("content-type") || "").includes("json")) continue;
      const json = await r.json();
      const request = e.name.split("?")[0];
      const walk = (x, depth) => {
        if (!x || typeof x !== "object" || depth > 7) return;
        if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return; }
        const url = x.subtitle_url ?? x.subtitleUrl;
        if (typeof url === "string" && url) out.tracks.push({ source: "player-api", lang: String(x.lan ?? x.lang ?? ""), label: String(x.lan_doc ?? x.label ?? ""), auto: !!x.ai_type || /^ai-/.test(String(x.lan ?? "")), url: url.startsWith("//") ? "https:" + url : url });
        for (const [k, v] of Object.entries(x)) { if (LIST.test(k) && Array.isArray(v)) out.lists.push({ request, field: k, count: v.length }); walk(v, depth + 1); }
      };
      walk(json, 0);
    } catch (error) { out.failed.push(e.name.split("?")[0] + "：" + String(error).slice(0, 60)); }
  }
  return out;
})()`;

/** 页面脚本的回值是页面里算出来的，进来前核对形状；不合格的条目丢掉。 */
function pageCaptions(value: unknown): PageCaptions {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const text = (v: unknown) => (typeof v === "string" ? v.slice(0, 300) : "");
  const array = (v: unknown) => (Array.isArray(v) ? v : []);
  const tracks = array(record.tracks).flatMap((item): CaptionTrack[] => {
    if (!item || typeof item !== "object") return [];
    const t = item as Record<string, unknown>;
    const source = ["video", "track", "youtube", "player-api"].includes(String(t.source)) ? t.source as CaptionTrack["source"] : null;

    if (!source) return [];
    const track: CaptionTrack = { source, lang: text(t.lang), label: text(t.label), auto: t.auto === true };

    if (typeof t.url === "string" && /^https?:\/\//.test(t.url)) track.url = t.url.slice(0, 600);

    if (typeof t.cues === "number") track.cues = t.cues;

    return [track];
  }).slice(0, 30);
  const lists = array(record.lists).flatMap(item => {
    const l = item && typeof item === "object" ? item as Record<string, unknown> : null;

    return l && typeof l.count === "number" ? [{ request: text(l.request), field: text(l.field), count: l.count }] : [];
  }).slice(0, 10);

  return { videos: typeof record.videos === "number" ? record.videos : 0, tracks, lists, failed: array(record.failed).map(text).filter(Boolean).slice(0, 5) };
}

function report(found: PageCaptions): string {
  const lines = ["Video captions on this page, read from the player itself (do not build subtitle API URLs yourself: some sites answer unsigned or guessed requests with another video's subtitles):"];
  lines.push(`- video elements: ${found.videos}`);

  for (const list of found.lists) lines.push(`- ${list.request} → ${list.field}: ${list.count} entr${list.count === 1 ? "y" : "ies"}`);

  for (const track of found.tracks) lines.push(`- track [${track.source}] ${track.lang || "?"} ${track.label}${track.auto ? " (auto-generated)" : ""}${track.cues != null ? ` · ${track.cues} cues loaded` : ""}${track.url ? ` · ${track.url}` : ""}`);

  for (const failure of found.failed) lines.push(`- could not re-read ${failure}`);
  const listed = found.lists.length > 0;

  if (found.tracks.length > 0) lines.push("Result: the video has the tracks above. Read one with fetch on its URL (it is the player's own address).");
  else if (listed) lines.push("Result: the player's own caption list for this video is empty — this video has no subtitles the player can load (not even auto-generated). Tell the user that; do not keep probing other endpoints.");
  else lines.push("Result: no caption tracks or caption list found on this page. If the video only shows captions after a button press, the player may load them then; otherwise it has none.");

  return lines.join("\n");
}

export async function videoCaptions(params: { tabId?: number }, sessionId: string = LEAD_SESSION_ID): Promise<{ text: string; tabId: number; tracks: number; lists: number }> {
  const tab = await resolveReadableTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  const reply = await sendCommand<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(tab.id, "Runtime.evaluate", { expression: READ_CAPTIONS, awaitPromise: true, returnByValue: true }, undefined, 15_000);
  const found = reply.result?.value ? pageCaptions(reply.result.value) : { videos: 0, tracks: [], lists: [], failed: ["页面脚本没有返回结果"] };

  return { text: report(found), tabId: tab.id, tracks: found.tracks.length, lists: found.lists.length };
}
