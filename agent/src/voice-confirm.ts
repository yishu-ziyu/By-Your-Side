/**
 * 语音控制句的读回确认。
 *
 * 实时转写会听错（实测把"BOSS直聘"听成"boss直拼"、把否定词整段丢掉），而控制句一旦认错
 * 就直接改动正在跑的任务。所以"改正在跑的任务/终止"这类句子先复述一遍，等用户确认再动手：
 * 慢一拍，但错一次的成本比慢一次高。见 docs/evals/20260911-voice-listen-back.md。
 */

/** 确认窗口：超过这个时间没回应就作废，避免几天后一句"对"误触发。 */
export const CONTROL_CONFIRM_TTL_MS = 90_000;

/** 肯定的短回答。只在"上一轮确实问过"时才会被这样解读。 */
const AFFIRMATIVE = /^(对|对的|对的对的|是|是的|嗯|确认|好|好的|可以|行|没错|就这个|就这样|继续|照做)$/;

/** 否定的短回答：撤回这次控制，不落任何动作。 */
const NEGATIVE = /^(不|不是|不对|不用|算了|取消|先别|不要|别|别动|停下)$/;

export function isControlConfirm(text: string): boolean {
  return AFFIRMATIVE.test(normalize(text));
}

export function isControlReject(text: string): boolean {
  return NEGATIVE.test(normalize(text));
}

/** 复述用用户自己的原话：转写错了才看得见，比"确认修改吗"有用。 */
export function controlConfirmMessage(text: string): string {
  const quoted = text.replace(/\s+/g, " ").trim().slice(0, 80);
  return `你是说“${quoted}”，对吗？确认后我就照做。`;
}

function normalize(text: string): string {
  return (text ?? "").replace(/[\p{P}\p{Z}\s]/gu, "");
}
