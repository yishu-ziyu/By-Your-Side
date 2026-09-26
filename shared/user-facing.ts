/**
 * 宿主文字到用户面前的最后一道翻译：工具名、元素编号、原始错误和 Chrome 错误码只留在记录和模型上下文里，
 * 侧栏、页面浮层和语音只说人话。
 *
 * 规则只有两条：用户面前永远不出现内部名字；翻不出来时说一句笼统但真实的话，不回退到原文。
 * 原文仍进诊断记录（run trace、agent.log），排查不受影响。
 */

/** 工具名 → 用户看得懂的动作（动宾短语，可直接接在「正在」后面）。 */
const TOOL_ACTIONS = new Map<string, string>(Object.entries({
  tabs: "查看标签页", list_tabs: "查看标签页", get_active_tab: "确认当前页面", open_tab: "打开标签页", switch_tab: "切换标签页", close_tab: "关闭标签页",
  navigate: "打开页面", snapshot: "读取页面", screenshot: "查看页面截图", read_page: "读取页面", read_element: "读取页面内容", read_elements: "读取页面内容",
  observe_page: "查看页面", network: "查看网页请求", judge_browser_action: "判断页面操作", capture_page_material: "保存页面原文", browser_loop: "操作网页",
  click: "点击", double_click: "双击", drag: "拖动", html5_drag: "拖动", hover: "定位元素", fill: "填写", type_text: "输入文字", paste: "粘贴",
  press_key: "按键", key_down: "按键", key_up: "按键", mouse_down: "按住鼠标", mouse_up: "松开鼠标", release_held_inputs: "松开按住的键", wheel: "滚动页面",
  scroll: "滚动页面", select_option: "选择选项", upload_file: "上传文件", file_chooser_set_files: "选择文件", page_operation: "填写并核对", page_translation: "翻译网页",
  browser_run: "连续操作网页", wait_for: "等待页面", sleep: "等待", arm_event: "等待页面事件", wait_event: "等待页面事件", disarm_event: "停止等待",
  accept_dialog: "确认弹窗", dismiss_dialog: "关闭弹窗", download_save_as: "保存下载", download_cancel: "取消下载", download_delete: "移除下载记录",
  js: "检查页面", cdp: "调用浏览器", mark: "标注页面", clear_marks: "清除标注", ask_user_to_point: "等你在页面上点选", fetch: "发送网络请求",
  browser_request: "发送网络请求", artifacts: "生成文件", remember_user_preference: "记住偏好", user_memory: "查看记忆",
  spawn_worker: "安排助手", list_workers: "查看助手", stop_worker: "让助手停下", post: "发送消息", await_message: "等待助手结果", share_tab: "安排同页协作",
  take_tab: "接手页面", worker_tabs: "调整页面归属", task_goals: "核对目标", task_status: "核对进度", record_task_results: "整理剩余步骤",
  resolve_unknown_result: "核对结果", confirm_blocked_write: "请你确认", send_user_message: "整理回答",
}));

/** 工具名翻成动作；没登记的工具不露原名，说「处理这一步」。 */
export function toolAction(name: string): string {
  return TOOL_ACTIONS.get(name) ?? "处理这一步";
}

/**
 * 账本里一步的说明（「填写 @1443」「fetch」「点击 loc=css:#save」）→ 人话。
 * 元素编号、定位符和工具名是给模型核对用的，用户看不懂也用不上。
 */
export function plainStep(description: string): string {
  const cleaned = description
    .replace(/loc=\S+/g, "")
    .replace(/@\d+/g, "")
    .replace(/(^|\s)[#.][A-Za-z_][\w-]*(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  // 去掉定位符后只剩一个动作（「填写 @3」→「填写」）：补上宾语，不留半句话。
  const text = cleaned !== description.trim() && !/\s/.test(cleaned) && cleaned.length <= 6 ? `${cleaned}页面上的一项` : cleaned;
  // 自动记账的说明以工具名开头（没登记中文名的工具）；模型或用户写的文字不改。
  const [head = "", ...rest] = text.split(" ");
  const plain = /^[a-z][a-z0-9_]*$/.test(head) ? [toolAction(head), ...rest].join(" ") : text;

  return plain || "处理这一步";
}

/**
 * 模型服务的错误 → 用户能处理的一句话。原文形如「503: {"message":...}」「Connection error.」「401 Unauthorized」。
 * 只按状态码和常见字样分类，不猜原因；分不出来时如实说没拿到回答。
 */
export function plainModelError(raw: string): string {
  const text = raw.replace(/^模型请求最终失败：/, "");

  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.{0,20}(api.?key|token)/i.test(text)) return "模型服务拒绝了请求：key 无效，或没有这个模型的权限。可以在「更多 → 模型与语音」里检查。";

  if (/\b429\b|rate.?limit|quota|insufficient|余额|额度/i.test(text)) return "模型服务说额度用完或请求太频繁，稍后再试，或在下方换一个模型。";

  if (/\b404\b|not.?found|does not exist|不存在/i.test(text)) return "找不到这个模型：可能已下线或当前账号没有权限，在下方换一个模型后重试。";

  if (/\b5\d\d\b|overload|unavailable|bad gateway|internal server error/i.test(text)) return "模型服务暂时出错（对方繁忙或故障），已重试几次仍没有回答。稍后再试，或在下方换一个模型。";

  if (/timeout|timed out|超时/i.test(text)) return "模型服务太久没有回应，这次没有拿到回答。稍后再试，或在下方换一个模型。";

  if (/connection|network|fetch failed|failed to fetch|ECONN|ENOTFOUND|socket/i.test(text)) return "连不上模型服务，检查网络后再试。";

  return "模型这次没有给出回答，可以再试一次或换一个模型。";
}

/** Chrome 下载中断原因（chrome.downloads InterruptReason）→ 人话。 */
const DOWNLOAD_REASONS = new Map<string, string>(Object.entries({
  FILE_FAILED: "文件没能写入下载文件夹", FILE_ACCESS_DENIED: "没有权限写入下载文件夹", FILE_NO_SPACE: "磁盘空间不够",
  FILE_NAME_TOO_LONG: "文件名太长", FILE_TOO_LARGE: "文件太大", FILE_VIRUS_INFECTED: "文件被判定为有病毒", FILE_TRANSIENT_ERROR: "写文件时出了临时错误",
  FILE_BLOCKED: "浏览器拦下了这个文件", FILE_SECURITY_CHECK_FAILED: "文件没通过安全检查", FILE_TOO_SHORT: "文件不完整", FILE_HASH_MISMATCH: "文件内容校验不一致",
  FILE_SAME_AS_SOURCE: "目标文件和来源相同",
  NETWORK_FAILED: "网络中断", NETWORK_TIMEOUT: "网络超时", NETWORK_DISCONNECTED: "网络断开了", NETWORK_SERVER_DOWN: "对方服务器没有响应", NETWORK_INVALID_REQUEST: "请求无效",
  SERVER_FAILED: "对方服务器出错", SERVER_NO_RANGE: "对方服务器不支持续传", SERVER_BAD_CONTENT: "对方服务器没有这个文件", SERVER_UNAUTHORIZED: "对方服务器要求登录或授权",
  SERVER_CERT_PROBLEM: "对方服务器的证书有问题", SERVER_FORBIDDEN: "对方服务器拒绝了下载", SERVER_UNREACHABLE: "连不上对方服务器",
  SERVER_CONTENT_LENGTH_MISMATCH: "服务器传来的文件不完整", SERVER_CROSS_ORIGIN_REDIRECT: "下载被跳转到了别的网站",
  USER_CANCELED: "下载被取消了", USER_SHUTDOWN: "浏览器关闭时下载中断了", CRASH: "浏览器出错，下载中断了",
}));

export function plainDownloadError(code: string | null | undefined): string {
  return (code && DOWNLOAD_REASONS.get(code)) || "下载中断了";
}
