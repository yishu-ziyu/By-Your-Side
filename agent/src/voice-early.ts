/**
 * 接话（early reply）安全台词校验。
 *
 * 接话发生在后台判定之前（用户话音落下 1–2ms 就开口），此刻模型没有任何事实可依据，
 * 只能自己编。实测编出过"这是 Chrome 的扩展管理页""你想把它移到哪个文件夹里"这类
 * 后台从未说过、页面里也不存在的内容。所以这一句只允许是"准备处理"的口语：
 * 出现具体对象、数字、拉丁词（多为专名）、动作或结果词，就不播它编的那句，改播固定台词。
 *
 * 见 docs/evals/20260911-voice-listen-back.md。
 */

/** 接话被拦下时改播的固定台词：不含任何事实，只说"我要开始了"。 */
export const EARLY_HOLD_LINE = "我看一下";

/** 具体对象：页面、文件、身份、领域名词。出现任何一个都说明它在报事实。 */
const CONTENT_TOKENS =
  /(网页|页面|标签|浏览器|扩展|插件|文件夹|目录|邮箱|截图|链接|网址|下载|文档|表格|报告|名单|价格|预算|版本|模型|会话|任务|图片|视频|文件|职位|简历|地址|账号|密码|广告|清单|分类)/;

/**
 * 结果宣称：接话阶段还没有回执，不能声称已经做过、做成了或收到了。
 * 注意这里只拦"已经发生"的措辞——"我来处理这个修改""我看一下"是在说打算做什么，属于接话本分。
 */
const CLAIM_TOKENS =
  /(已接收|已送达|已发送|已经|已完成|完成|成功|失败|搞定|好了|没问题|收到)/;

const MAX_CHARS = 24;

/**
 * 通过校验返回清理后的台词，否则返回 null（调用方改播 {@link EARLY_HOLD_LINE}）。
 * 规则刻意守得死：宁可少说一句，也不能在没有事实的时候替后台描述世界。
 */
export function safeEarlyText(raw: string): string | null {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > MAX_CHARS) return null;
  if (/[0-9０-９]/.test(text)) return null;
  // 拉丁词多是专名（BOSS、Chrome、URL）或内部字段，接话不报专名。
  if (/[A-Za-z]{2,}/.test(text)) return null;
  if (CONTENT_TOKENS.test(text)) return null;
  if (CLAIM_TOKENS.test(text)) return null;
  if ((text.match(/[。！？!?]/g) ?? []).length > 1) return null;
  return text;
}
