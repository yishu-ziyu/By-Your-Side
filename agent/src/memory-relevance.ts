/**
 * Relevance between a stored memory and this turn's request.
 *
 * Explicit preferences keep the permissive rule: one shared term is enough
 * there, because a preference may be about the action itself
 * ("导出时用 CSV 格式" applies to any export).
 *
 * Automatic, unedited experiences describe one concrete task. They must share
 * the task object with this turn; a shared action word such as "导出" is not
 * enough. When both sides state a recognized action, the actions must also be
 * compatible, so the "导出客户名单" procedure is never reused for "删除客户名单".
 * An experience whose topic carries no object term is rejected conservatively
 * rather than matched on its action alone.
 *
 * Matching stays plain term overlap: no synonym table, embedding or model call.
 * A reworded task that shares neither the object nor the action is missed on
 * purpose; a silent miss is preferable to injecting the wrong workflow.
 */

const BOILERPLATE_TERMS = new Set([
  "整理", "帮我", "请用", "请你", "给我", "以后", "今后", "下次", "记住", "使用", "所有", "会话", "用于", "可以", "需要", "时候",
]);

/** Request verbs, not task objects. Shared action words alone never match an experience. */
const ACTION_TERMS = new Set([
  // Chinese request verbs, at the same 2-4 character granularity as the term tokenizer.
  "导出", "导入", "下载", "上传", "发送", "提交", "删除", "移除", "清除", "清空", "清理", "创建", "新建", "新增", "添加",
  "修改", "编辑", "更新", "保存", "填写", "输入", "登录", "注销", "注册", "打开", "关闭", "查看", "浏览", "检查", "核对",
  "查询", "搜索", "查找", "筛选", "排序", "复制", "粘贴", "移动", "重命名", "命名", "分享", "转发", "打印", "同步", "备份",
  "恢复", "还原", "整理", "总结", "汇总", "统计", "计算", "比较", "对比", "分析", "生成", "制作", "转换", "合并", "拆分",
  "分割", "替换", "刷新", "加载", "截图", "录制", "播放", "暂停", "停止", "启动", "运行", "部署", "发布", "推送", "订阅",
  "收藏", "点赞", "评论", "回复", "咨询", "预约", "报名", "支付", "购买", "下单", "取消", "确认", "审批", "去重", "迁移",
  // English request verbs at the same granularity (at least three characters).
  "export", "import", "download", "upload", "send", "submit", "delete", "remove", "create", "add", "edit", "update", "save",
  "fill", "login", "open", "close", "view", "check", "verify", "search", "find", "filter", "sort", "copy", "paste", "move",
  "rename", "share", "forward", "print", "sync", "backup", "restore", "organize", "summarize", "aggregate", "count",
  "calculate", "compare", "analyze", "generate", "build", "convert", "refresh", "load", "record", "start", "stop", "publish",
]);

const ENGLISH_STOP_WORDS = ["the", "please", "remember", "always", "use", "with", "for", "this", "that"];

/** Loose relevance for explicit preferences: any shared term counts. */
export function isRelevantMemory(memory: string, query: string): boolean {
  const queryTerms = memoryTerms(query);
  for (const term of memoryTerms(memory)) if (queryTerms.has(term)) return true;
  return false;
}

/** Strict relevance for automatic, unedited experiences: the task object must match. */
export function isRelevantExperience(topic: string, query: string): boolean {
  const memory = memoryTerms(topic);
  const asked = memoryTerms(query);
  const shared = [...memory].filter((term) => asked.has(term));
  if (!shared.some((term) => !ACTION_TERMS.has(term))) return false;
  const memoryActions = [...memory].filter((term) => ACTION_TERMS.has(term));
  if (memoryActions.length === 0) return true;
  if (memoryActions.some((term) => asked.has(term))) return true;
  // A request that names no recognized action keeps matching by object alone.
  return ![...asked].some((term) => ACTION_TERMS.has(term));
}

function memoryTerms(text: string): Set<string> {
  const normalized = text.normalize("NFKC").toLowerCase();
  const out = new Set<string>();
  // Split scripts before tokenizing: a project number must not swallow adjacent
  // Chinese words into one unmatchable token. Common request verbs are not topics.
  for (const word of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let size = 2; size <= Math.min(4, word.length); size += 1) {
      for (let i = 0; i + size <= word.length; i += 1) {
        const term = word.slice(i, i + size);
        if (!BOILERPLATE_TERMS.has(term)) out.add(term);
      }
    }
  }
  for (const word of normalized.replace(/[\p{Script=Han}]/gu, " ").match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (word.length >= 3 && !ENGLISH_STOP_WORDS.includes(word)) out.add(word);
  }
  return out;
}
