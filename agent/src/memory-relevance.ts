const BOILERPLATE_TERMS = new Set([
  "整理", "帮我", "请用", "请你", "给我", "以后", "今后", "下次", "记住", "使用", "所有", "会话", "用于", "可以", "需要", "时候",
]);

const ACTION_TERMS = new Set([
  "导出", "导入", "下载", "上传", "发送", "提交", "删除", "移除", "清除", "清空", "清理", "创建", "新建", "新增", "添加",
  "修改", "编辑", "更新", "保存", "填写", "输入", "登录", "注销", "注册", "打开", "关闭", "查看", "浏览", "检查", "核对",
  "查询", "搜索", "查找", "筛选", "排序", "复制", "粘贴", "移动", "重命名", "命名", "分享", "转发", "打印", "同步", "备份",
  "恢复", "还原", "整理", "总结", "汇总", "统计", "计算", "比较", "对比", "分析", "生成", "制作", "转换", "合并", "拆分",
  "分割", "替换", "刷新", "加载", "截图", "录制", "播放", "暂停", "停止", "启动", "运行", "部署", "发布", "推送", "订阅",
  "收藏", "点赞", "评论", "回复", "咨询", "预约", "报名", "支付", "购买", "下单", "取消", "确认", "审批", "去重", "迁移",
  "export", "import", "download", "upload", "send", "submit", "delete", "remove", "create", "add", "edit", "update", "save",
  "fill", "login", "open", "close", "view", "check", "verify", "search", "find", "filter", "sort", "copy", "paste", "move",
  "rename", "share", "forward", "print", "sync", "backup", "restore", "organize", "summarize", "aggregate", "count",
  "calculate", "compare", "analyze", "generate", "build", "convert", "refresh", "load", "record", "start", "stop", "publish",
]);

const ENGLISH_STOP_WORDS = ["the", "please", "remember", "always", "use", "with", "for", "this", "that"];

export function isRelevantMemory(memory: string, query: string): boolean {
  const queryTerms = memoryTerms(query);

  for (const term of memoryTerms(memory)) if (queryTerms.has(term)) return true;

  return false;
}

export function isRelevantExperience(topic: string, query: string): boolean {
  const memory = memoryTerms(topic);
  const asked = memoryTerms(query);
  const shared = [...memory].filter((term) => asked.has(term));

  if (!shared.some((term) => !ACTION_TERMS.has(term))) return false;
  const memoryActions = [...memory].filter((term) => ACTION_TERMS.has(term));

  if (memoryActions.length === 0) return true;

  if (memoryActions.some((term) => asked.has(term))) return true;

  return ![...asked].some((term) => ACTION_TERMS.has(term));
}

const FILLER = ["帮我", "请你", "请", "麻烦", "一下", "查一", "看一", "一查", "一看", "看看", "这个", "那个", "这款", "这页", "这里", "那里", "怎么", "怎样", "什么", "可以", "一个",
  "打开", "点击", "点开", "进入", "查看", "浏览", "关闭", "切换", "返回", "回到", "网站", "网页", "页面", "标签页"];

const ENGLISH_BROWSING = ["open", "click", "view", "close", "page", "website", "tab"];

export function isNamedForRequest(memory: string, query: string): boolean {
  const asked = namingTerms(query);

  for (const term of namingTerms(memory)) if (asked.has(term)) return true;

  return false;
}

export function isRelevantPastTask(memory: string, query: string, forDisplay = false): boolean {
  const terms = forDisplay ? namingTerms : memoryTerms;
  const subjects = (text: string) => terms(text.replace(/这些|那些|这个|那个|一些|我们|你们|他们|它们|这次|那次/gu, " "));
  const asked = subjects(query);

  return [...subjects(memory)].some(term => asked.has(term));
}

function namingTerms(text: string): Set<string> {
  const terms = memoryTerms(text);
  const fillerOnly = new Set<string>();
  const kept = new Set<string>();

  for (const run of text.normalize("NFKC").toLowerCase().match(/[\p{Script=Han}]+/gu) ?? []) {
    const covered = new Array<boolean>(run.length).fill(false);

    for (const phrase of FILLER) {
      for (let at = run.indexOf(phrase); at >= 0; at = run.indexOf(phrase, at + 1)) covered.fill(true, at, at + phrase.length);
    }

    for (let size = 2; size <= Math.min(4, run.length); size += 1) {
      for (let i = 0; i + size <= run.length; i += 1) (covered.slice(i, i + size).every(Boolean) ? fillerOnly : kept).add(run.slice(i, i + size));
    }
  }

  for (const term of fillerOnly) if (!kept.has(term)) terms.delete(term);

  for (const word of ENGLISH_BROWSING) terms.delete(word);

  return terms;
}

function memoryTerms(text: string): Set<string> {
  const normalized = text.normalize("NFKC").toLowerCase();
  const out = new Set<string>();

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
