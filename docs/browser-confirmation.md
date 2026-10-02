# 浏览器逐次确认

## 执行边界

扩展执行边界对所有潜在网页副作用逐次请求侧栏“允许一次”：点击、填写、选择、导航、开关页面、GET/POST、页面脚本及处理弹窗都包括在内。页面文案、模型label、readonly声明和旧聊天中的“好的”均不能免确认。免批仅原生标签清单/活动标签、网络/对话框/下载状态、事件缓存、worker inspect及raw CDP只读白名单。公开读取、标注、观察与清理也需批准。

侧栏展示本次完整参数（凭据模式脱敏，超过65536字符拒绝），后台保留独立参数副本。请求绑定任务、控制轮次、原标签页、documentId、隔离DOM变更轮次、原生DOMSnapshot节点/字段及markup摘要；批准时与执行前重读，变化即拒绝。点击/JS在CDP派发前再核对；attach等异步步骤结束后同步复核取消轮次与期限，输入释放完成已开始的按键/鼠标对。只接受扩展自身sidepanel.html的runtime Port决定；页面名牌事件不铸造授权。重复批准不重复派发，未覆盖的子框架拒绝；新用户指令、断线及20秒到期会作废请求；核对中仍可拒绝，已拒请求不复活。

底层mouse_down/mouse_up/key_down/key_up/release_held_inputs、drag/html5_drag和Enter/Space暂拒绝，使用click或完整press_key或接管；停止时内部释放输入。页面脚本可经逐次确认执行，所以声明式读取后在browser_run内整理并saveFile仍可用。

**验收边界：** 指纹不锁站点事务或隐藏状态。真实入口已验收；合并见[#38](https://github.com/yishu-ziyu/By-Your-Side/pull/38)。

## 已确认表单要求

宿主可给 `click`、`double_click`、`fill`、`type_text`、`select_option`、`press_key` 附加 `formRequirements:[{label,hostname?}]`；模型不能自报。仅提取有效已确认方法的引号字段。`hostname` 精确匹配当前主机名，缺省适用当前页。规则见[记忆模型](memory-model.md)。

提交点击、确认重放及表单提交 Enter 前均重读表单（含 `form` 关联控件）。要求字段须按真实 label、aria-label/aria-labelledby、placeholder、name 或 id 唯一匹配可读非空原生 input/textarea/select。仅规范化大小写、空白、末尾冒号/星号，不猜别名。未找到、多候选、不可读或空值均返回 `not_executed`，要求补字段；内容未知先问用户。普通 textarea/select/contenteditable Enter 不查，修饰键 Enter 保守检查。拒绝不可读 iframe。

`fill`/`type_text`/`select_option` 匹配要求字段时，只有宿主证实值来自本任务用户原话、有效个人资料或既有核验通过的复制材料并附 `userValueProvided:true` 才可写入。受约束字段拒绝逐键文字和粘贴，改用完整原话。站点资料还附`userValueHostname`，不匹配时拒绝。拒绝不清除已有值，也不改网页 `required` 或其他表单状态。其他字段、读取和普通按键不受影响，原确认保留。宿主另拒绝受约束网站的 evaluate/POST 等绕过；不覆盖任意脚本、控件或方法语义。
