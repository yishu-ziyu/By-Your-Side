/**
 * Panel selectors: conversation state labels and the result card copy.
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
