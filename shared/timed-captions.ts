export interface TimedCaption { start: number; end: number; text: string }

export interface ParsedCaptions { cues: TimedCaption[]; format: string }

export interface CaptionTrackChoice { lang: string; auto: boolean; url?: string }

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const finite = (value: unknown, fallback = 0): number => {
  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
};

const decode = (value: string) => value.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => {
  const point = code[0]!.toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);

  return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "\uFFFD";
}).replace(/&(lt|gt|quot|apos);/g, (_, name: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'" })[name] ?? "");

const clockSeconds = (value: string): number => {
  const parts = value.trim().replace(",", ".").split(":").map(Number);

  return parts.reduce((total, part) => total * 60 + (Number.isFinite(part) ? part : 0), 0);
};

const attribute = (attrs: string, name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

export function parseTimedCaptions(text: string): ParsedCaptions | null {
  try {
    const value = record(JSON.parse(text));

    if (value && Array.isArray(value.body)) {
      const lines = value.body.map(record).filter((item): item is Record<string, unknown> => !!item && typeof item.content === "string");

      if (lines.length === value.body.length && lines.length) return { format: "bilibili-json", cues: lines.map(item => ({ start: finite(item.from), end: finite(item.to), text: String(item.content) })) };
    }

    if (value && Array.isArray(value.events)) {
      const cues = value.events.map(record).flatMap((item): TimedCaption[] => {
        if (!item || !Array.isArray(item.segs)) return [];
        const line = item.segs.map(record).flatMap(segment => typeof segment?.utf8 === "string" ? [segment.utf8] : []).join("");
        const start = finite(item.tStartMs) / 1000;

        return [{ start, end: start + finite(item.dDurationMs) / 1000, text: line }];
      });

      if (cues.length) return { format: "youtube-json3", cues };
    }
  } catch { }

  if (/^\uFEFF?WEBVTT\b/.test(text)) {
    const cues = text.split(/\r?\n\r?\n/).flatMap((block): TimedCaption[] => {
      const parts = block.split(/\r?\n/);
      const at = parts.findIndex(line => /\d{2}:\d{2}.*-->/.test(line));

      if (at < 0) return [];
      const [from = "", to = ""] = parts[at]!.split("-->");
      const line = decode(parts.slice(at + 1).join("\n"));

      return line ? [{ start: clockSeconds(from), end: clockSeconds(to.trim().split(/\s/)[0] ?? ""), text: line }] : [];
    });

    if (cues.length) return { format: "webvtt", cues };
  }

  if (/<(?:transcript|timedtext)\b/.test(text)) {
    const cues = [...text.matchAll(/<(text|p)\b([^>]*)>([\s\S]*?)<\/(?:text|p)>/g)].flatMap((match): TimedCaption[] => {
      const line = decode(match[3]!);

      if (!line) return [];
      const seconds = match[1] === "text";
      const start = seconds ? finite(attribute(match[2]!, "start")) : finite(attribute(match[2]!, "t")) / 1000;
      const length = seconds ? finite(attribute(match[2]!, "dur")) : finite(attribute(match[2]!, "d")) / 1000;

      return [{ start, end: start + length, text: line }];
    });

    if (cues.length) return { format: "timedtext", cues };
  }

  return null;
}

export function pickCaptionTrack<T extends CaptionTrackChoice>(tracks: T[], language: string): T | undefined {
  const readable = tracks.filter(track => track.url);
  const base = (lang: string) => lang.toLowerCase().split("-")[0];
  const wanted = base(language);
  const spoken = readable.find(track => track.auto);

  return readable.find(track => !track.auto && base(track.lang) === wanted)
    ?? (spoken ? readable.find(track => !track.auto && base(track.lang) === base(spoken.lang)) ?? spoken : undefined)
    ?? readable.find(track => base(track.lang) === wanted)
    ?? readable[0];
}
