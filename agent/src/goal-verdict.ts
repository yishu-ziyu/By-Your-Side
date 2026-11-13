export interface GoalItem { text: string; done: boolean }

export interface GoalVerificationTarget { target: string; tabId?: number }

export type GoalVerdict = { status: "done" | "needs_user" | "continue" | "open" | "blocked"; remaining: string | null; cause?: string; correction?: string; finding?: string; items?: GoalItem[]; verificationTargets?: GoalVerificationTarget[]; evidence?: string; verificationSubject?: 'page' | 'file' | 'answer'; verifiedByHost?: true; repair?: "ask_user" | "complete_task" };

export function asksUser(reply: string): boolean {
  const tail = reply.replace(/https?:\/\/[^\s)）\]」"'<>]+/g, "").trimEnd().slice(-160);
  const asked = tail.replace(/《[^》]*》|“[^”]*”|"[^"\n]*"|「[^」]*」|`[^`]*`|\[[^\]]*\]/g, "");

  return /[?？]/u.test(asked.slice(-100))
    || /请(把|提供|告诉|确认|回复|选择|发给?我|输入|填写你)|告诉我|发(给)?我|回复(我|「|“|")|需要你(的|提供|确认|先)|等你(确认|回复|提供)|please (provide|tell|confirm|reply|send)|let me know/iu.test(tail);
}

export function pageAwaitsEmailStep(pageText: string): boolean {
  return /(确认|验证|激活|注册|重置|找回|登录)[^\s。，,：:；;！!？?、]{0,6}(邮件|链接)[^\s。，,：:；;！!？?、]{0,12}\s*已(经)?(成功)?(发送|发出|寄出|发至|发到)(?![^。，,；;！!\n]{0,6}(手机|短信|号码))|(邮件|邮箱)(确认|验证|激活)[^\s。，,：:；;！!？?、]{0,8}已(经)?(成功)?(发送|发出|寄出|发至|发到)(?![^。，,；;！!\n]{0,6}(手机|短信|号码))|已(经)?(成功)?(发送|发出|寄出|发)(了)?(至|到)?(你|您)的?(注册)?(电子)?(邮箱|邮件)|已(经)?(成功)?(发送|发出|寄出|发)(了)?(一封)?(确认|验证|激活|注册)[^\s。，,]{0,4}(邮件|链接)|已(经)?(向|给|往)[^。；;！!？?\n]{0,40}(邮箱|@)[^。；;！!？?\n]{0,30}(发送|发出|寄出|发)(了)?[^。；;\n]{0,6}(确认|验证|激活|注册)|(给|向)(你|您)(发|寄)(送)?了一封|查收[^\s。，,；;！!]{0,6}(邮件|邮箱)|(?<!(勿|别|不要|无法|不能|未能|没法|不用)[^。，,；;！!\s]{0,3})((去|前往|打开)邮箱|(登录|查看)(你|您)的邮箱|(点击?|打开)邮件(中|里)的?[^\s。，,；;！!]{0,4}(链接|按钮))|(sent|emailed)(?![^.;!?\n]{0,40}\b(phone|sms|mobile)\b)[^.;!?\n]{0,40}\b(e-?mail|inbox)\b|\bemailed you\b|\be-?mail (has been|was) sent to you\b|(confirmation|verification|activation) e-?mail (has been |was )?sent|(magic|sign-?in|confirmation|verification|activation) link (has been |was |is )?(sent|on its way)(?![^.;!?\n]{0,20}\b(phone|sms|text|mobile)\b)|check your (e-?mail|inbox|mail)\b|(?<!(do not|don't|never) )click (on )?the (link|button) in (that|the|your|this) e-?mail/i.test(pageText);
}

export function emailStepIsNext(pageText: string, reply: string): boolean {
  if (!pageAwaitsEmailStep(pageText)) return false;
  const asks = reply.replace(/https?:\/\/[^\s)）\]」"'<>。，！？；、]+/g, "").trimEnd().slice(-160).split(/(?<=[。！？!?；;，,\n])|(?<=\.)\s+/).filter(clause => asksUser(clause));

  return asks.every(clause => !/还是|或者|或是|\bor\b|提供|告诉|发给?我|输入|填写|验证码|密码|\bcode\b|password|provide|tell me|send me/i.test(clause) && /(打开|去|前往|查看|登录|进入|查收)[^，,。？?]{0,6}(邮箱|收件箱|邮件|gmail|outlook|mail)|(点击?|确认)[^，,。？?]{0,4}邮件(中|里)?的?[^，,。？?]{0,4}(链接|按钮)|open (your |the )?(gmail|outlook|inbox|mailbox|e-?mail)|check (your )?(inbox|e-?mail|mail)|click the (confirmation |verification )?link/i.test(clause));
}

const UNFINISHED_VERB = "(?:完成|做完|做成|做到|成功|拿到|找到|打开|提交|送达|收到|保存|下载|登录|进入|获取|获得|读到|读出|发出|发送)";
const UNFINISHED = new RegExp(`还没(?:能|有)?(?:完成|点|收到|送达|到|确认|提交)|(?:没能|未能|没有能)${UNFINISHED_VERB}|尚未(?:完成|收到|送达|确认)|没有(?:完成|收到|送达)|not (?:yet )?(?:done|finished|arrived|received|confirmed)|(?:couldn'?t|could not|was unable to|unable to) (?:complete|finish|find|get|open|submit|access|load|save|download|send)|has(?:n'?t| not) arrived`, "i");

function claimsUnfinished(reply: string): boolean {
  return UNFINISHED.test(reply);
}

export function gaveUpWithoutChange(input: { reply: string; partial: boolean; pageAtNudge: string | null; pageNow: string | null }): boolean {
  const content = (page: string | null) => page?.replace(/\[ref=[^\]]*\]\s?/g, "") ?? null;

  if (!input.pageNow || content(input.pageAtNudge) !== content(input.pageNow) || asksUser(input.reply)) return false;

  return input.partial || claimsUnfinished(input.reply);
}
