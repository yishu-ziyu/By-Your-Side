/**
 * Panel selectors: the four questions the user should see immediately.
 */
import type { ConversationSummary } from '../../../shared/protocol.js';

export function conversationStateLabel(c: Pick<ConversationSummary, 'state' | 'checkpoint'>): string {
  if (c.checkpoint === 'unavailable') {
    return '恢复失败';
  }

  if (c.checkpoint === 'interrupted') {
    return '已中断';
  }

  if (c.state === 'running') {
    return '运行中';
  }

  if (c.state === 'user') {
    return '现在归你';
  }

  return '空闲';
}

export function conversationBackgroundLabel(c: Pick<ConversationSummary, 'state' | 'checkpoint'>): string {
  if (c.checkpoint === 'unavailable') {
    return '恢复失败，未执行';
  }

  if (c.checkpoint === 'interrupted') {
    return '已中断，可继续';
  }

  if (c.state === 'running') {
    return '后台运行中';
  }

  if (c.state === 'user') {
    return '现在归你';
  }

  return '已结束';
}

export function sessionQuestion(title: string | null | undefined): string {
  return (title || "新会话").trim() || "新会话";
}

export function pageQuestion(title: string | null | undefined, host: string | null | undefined): string {
  const name = (title || "").trim();
  const site = (host || "").trim();

  if (name && site) {
    return `${name} / ${site}`;
  }

  return name || site || "当前页未知";
}

export function actionQuestion(opts: {
  running: boolean;
  action?: string | null;
  elapsedSec?: number | null;
  result?: string | null;
}): string {
  if (opts.running) {
    const name = (opts.action || "正在处理").trim();
    const sec = opts.elapsedSec != null && Number.isFinite(opts.elapsedSec) ? ` · ${opts.elapsedSec.toFixed(1)}秒` : "";

    return `${name}${sec}`;
  }

  if (opts.result) {
    return opts.result;
  }

  return "空闲";
}

export function controlQuestion(opts: {
  userHasPage: boolean;
  draining?: boolean;
  running?: boolean;
}): string {
  if (opts.draining) {
    return "正在交接";
  }

  if (opts.userHasPage) {
    return "现在归你";
  }

  if (opts.running) {
    return "Agent 在操作";
  }

  return "空闲";
}

export function micQuestion(listening: boolean): string {
  return listening ? "麦克风：正在听" : "麦克风：已关";
}

export function speechQuestion(speaking: boolean): string {
  return speaking ? "声音：正在说" : "声音：未说";
}

/** 结果卡：摘要是主信息，剩余项和声音失败弱化。没有摘要时整张卡不出现。 */
export function resultCardCopy(opts: {
  summary: string | null;
  remaining?: string[];
  unknown?: boolean;
  speechFailed?: boolean;
}): {
  visible: boolean;
  primary: string;
  secondary: string;
} {
  const summary = (opts.summary ?? "").trim();
  const remaining = (opts.remaining ?? []).map((item) => item.trim()).filter(Boolean);

  if (!summary && !remaining.length && !opts.unknown && !opts.speechFailed) {
    return { visible: false, primary: "", secondary: "" };
  }

  let primary: string;

  if (summary) {
    primary = summary;
  } else if (opts.unknown) {
    primary = "这次结果还没法确认";
  } else if (remaining.length) {
    primary = `还剩${remaining.join("、")}`;
  } else {
    primary = "";
  }

  const extra: string[] = [];

  if (summary && remaining.length) {
    extra.push(`还剩${remaining.join("、")}`);
  }

  if (opts.speechFailed) {
    extra.push("声音未完成，文字仍可查看");
  }

  return { visible: primary.length > 0 || extra.length > 0, primary, secondary: extra.join(" · ") };
}
