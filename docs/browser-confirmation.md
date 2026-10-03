# 浏览器逐次确认

## 执行边界

扩展执行边界对所有潜在网页副作用逐次请求侧栏“允许一次”：点击、填写、选择、导航、开关页面、GET/POST、页面脚本及处理弹窗都包括在内。页面文案、模型label、readonly声明和旧聊天中的“好的”均不能免确认。免批仅原生标签清单/活动标签、网络/对话框/下载状态、事件缓存、worker inspect及raw CDP只读白名单。公开读取、标注、观察与清理也需批准。

侧栏展示本次完整参数（凭据模式脱敏，超过65536字符拒绝），后台保留独立参数副本。请求绑定任务、控制轮次、原标签页、documentId、隔离DOM变更轮次、原生DOMSnapshot节点/字段及markup摘要；批准时与执行前重读，变化即拒绝。点击/JS在CDP派发前再核对；attach等异步步骤结束后同步复核取消轮次与期限，输入释放完成已开始的按键/鼠标对。只接受扩展自身sidepanel.html的runtime Port决定；页面名牌事件不铸造授权。重复批准不重复派发，未覆盖的子框架拒绝；新用户指令、断线及20秒到期会作废请求；核对中仍可拒绝，已拒请求不复活。

底层mouse_down/mouse_up/key_down/key_up/release_held_inputs、drag/html5_drag和Enter/Space暂拒绝，使用click或完整press_key或接管；停止时内部释放输入。页面脚本可经逐次确认执行，所以声明式读取后在browser_run内整理并saveFile仍可用。

**验收边界：** 指纹不锁站点事务或隐藏状态。真实入口已验收；合并见[#38](https://github.com/yishu-ziyu/By-Your-Side/pull/38)。

activation卡显示真实工具动作和目标，不把会话标题标为当前任务；必要重设的recovery卡仍显示原目标。侧栏只显示pending请求，结束后自动移除卡片；在原有效期内保留已结束ID，防止迟到列表复活旧卡。真实列表仍附加后台当前待批请求，不影响新请求批准；过期旧请求也不能重新成为可操作卡。

## 原生弹窗

原生弹窗会暂停网页脚本。处理弹窗时不读取网页 DOM 建立批准指纹，而绑定后台原生事件的递增身份、弹窗内容、标签页、任务、取消轮次及精确参数。侧栏仍须允许一次；关闭、替换、拒绝或停止后原批准作废。同文案的新弹窗不能复用旧批准。其他网页操作先报告弹窗阻塞，使用 dialog_info 查询，再批准 accept_dialog/dismiss_dialog。

## 已确认表单要求

宿主可给 `click`、`double_click`、`fill`、`type_text`、`select_option`、`press_key` 附加 `formRequirements:[{label,hostname?}]`；模型不能自报。仅提取有效已确认方法的引号字段。`hostname` 精确匹配当前主机名，缺省适用当前页。规则见[记忆模型](memory-model.md)。

提交点击、确认重放及表单提交 Enter 前均重读表单（含 `form` 关联控件）。要求字段须按真实 label、aria-label/aria-labelledby、placeholder、name 或 id 唯一匹配可读非空原生 input/textarea/select。仅规范化大小写、空白、末尾冒号/星号，不猜别名。未找到、多候选、不可读或空值均返回 `not_executed`，要求补字段；内容未知先问用户。普通 textarea/select/contenteditable Enter 不查，修饰键 Enter 保守检查。拒绝不可读 iframe。

`fill`/`type_text`/`select_option` 匹配要求字段时，只有宿主证实值来自本任务用户原话、有效个人资料或既有核验通过的复制材料并附 `userValueProvided:true` 才可写入。受约束字段拒绝逐键文字和粘贴，改用完整原话。站点资料还附`userValueHostname`，不匹配时拒绝。拒绝不清除已有值，也不改网页 `required` 或其他表单状态。其他字段、读取和普通按键不受影响，原确认保留。宿主另拒绝受约束网站的 evaluate/POST 等绕过；不覆盖任意脚本、控件或方法语义。

要求字段的提交检查先按原目标（AX ref、定位器或给定点）只读核对，再定位光标/滚动；字段缺失时报告未执行，用户补充内容可继续。实际派发前仍按最终命中点重查，定位后发现页面变化或已开始的效果不冒充未执行。

页面状态绑定先等待扩展已经请求的边缘提示绘制结束，避免其闭合shadow样式更新让本次确认误作废；网页状态、原生字段与任务比较仍完整保留，不通过忽略公共标记节点放宽检查。原生弹窗处理仍不执行网页脚本。
