# 会话独立执行与同页多 Agent 协作

日期：2026-09-08。性质：主源调研与方案判断，未实现产品，未做浏览器并发实验。

## 用户已明确的行为

- 新建会话 B 不暂停 A；A 的任务继续属于 A，切换只是用户注意力和展示位置变化。
- 不同会话可以访问同一 URL，但分别使用自己的标签页。
- 未保存的同一份简历不能靠开两个标签页实现共同编辑。期望多个子 Agent 在同一页分工，并用不同颜色光标表达各自工作。
- 未来可研究 A/B 的材料与讨论汇入 C；本次不把合并历史、移交任务或自动续跑当已实现能力。

## 参考一：ego-lite

[官方仓库](https://github.com/citrolabs/ego-lite)与[贡献说明](https://github.com/citrolabs/ego-lite/blob/main/CONTRIBUTING.md)明确：任务空间拥有各自的标签集合，继承用户登录状态；浏览器端保存空间状态。公开仓库提供 helper/runtime，不能把它视为浏览器完整源码。

实际读取了上游 [helpers.ts](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/src/helpers.ts)：`useOrCreateTaskSpace` 选择或创建空间；ownership 区分 agent/user/交接状态；控制权限制由 native bridge 在执行真实命令时落实。[browser-runtime.ts](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/src/browser-runtime.ts)还处理 inactive/user-controlled/not-claimed 导致的发送失败。

可借鉴的是“稳定任务身份 → 有范围的标签集合 → 执行前检查控制权”。不据此声称 Space 隔离了所有 cookie、站点存储或服务端对象，也未查证其原生内部如何实现。

## 参考二：Kimi WebBridge

[官方产品页](https://www.kimi.com/products/kimi-webbridge)确认它是本地桥接服务与浏览器扩展组合。具体会话机制依据本机安装的 [Kimi WebBridge SKILL.md](/Users/mahaoxuan/.agents/skills/kimi-webbridge/SKILL.md:79)，版本 1.11.5：

- 一个任务使用一个 session，其创建的页面归入一个标签组。
- 每个指令都携带 session；同一任务跨站点不切 session。
- `find_tab` 默认只查当前 session 的标签，找不到则新建。
- `active:true` 是显式借用用户当前页，借用页留在原位置，不拉进任务组。

因此，分组与执行范围是两部分。彩色标签组本身不能防止 Agent 操作别组的 tabId。本次未检查 Kimi 扩展源码，也未证明它对两个 session 借用同一标签的底层仲裁行为。

## 浏览器约束

1. **插件能实现标签组。** Chrome 提供 [tabs 的创建/复制/分组](https://developer.chrome.com/docs/extensions/reference/api/tabs)与[tabGroups 的命名/颜色/折叠](https://developer.chrome.com/docs/extensions/reference/api/tabGroups)。因此独立浏览器不是按任务管理页面的必要条件。Chrome groupId 只是浏览器会话内标识，不宜成为持久会话主键。
2. **同 URL 不等于同一份可编辑状态。** [sessionStorage 文档](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)说明标签之间存储分开，即使初始复制后也不会持续同步。新开/复制标签不是持续复制 DOM、JS 内存和未保存表单的机制；具体网站是否同步需实际检查。
3. **分开标签也可能改同一服务端对象。** 若同账号的两个页面都自动保存同一份简历，是否覆盖取决于网站的保存与冲突处理。这是对共享对象的推论，不能承诺仅开标签就全面隔离。
4. **彩色光标不产生独立输入焦点。** [activeElement](https://developer.mozilla.org/en-US/docs/Web/API/Document/activeElement)描述接收键盘事件的焦点元素；[CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)的鼠标/键盘接口没有按 Agent 提供独立键盘焦点。多个覆盖层光标可以并存，但点击、选择、滚动、输入仍会改变共享页面状态。

## 当前产品代码核查

本轮由 GPT-5.6 Luna / Max 做只读调用链检查，以下是静态结论，未复现并发故障：

- [Fleet.spawn](../../agent/src/fleet.ts#L228) 已为 worker 新建工作标签并绑定 session；[open_tab](../../extension/src/background/exec/tabs.ts#L40) 对相同 URL 也新建。现有协议 `TeamView.groupId` 是接管组，不是 Chrome 原生标签组。
- [RPC](../../agent/src/rpc.ts#L49) 已传 sessionId，[后台工具分发](../../extension/src/background/index.ts#L567)据此定位工作页。它仍是一个 Lead 下的 worker 路由，不等于多个用户会话的运行时。
- [state.ts](../../extension/src/background/state.ts#L62) 普通认领会避开已绑定页；但显式 switch_tab 可直接写入绑定。[tab-bindings.ts](../../extension/src/background/tab-bindings.ts#L8) 允许双绑，而 sessionForTab 只取第一个匹配，事件归属存在歧义。不能把可双绑误认为已经支持共享页协作。
- [ControlGate.run](../../shared/control.ts#L357) 管接管门禁和在途调用，没有按页互斥；[debugger.ts](../../extension/src/background/debugger.ts#L10) 管连接，没有输入命令队列；browser_run 只保证自身程序内动作顺序。
- [cursor.for(id)](../../extension/src/content/cursor.ts#L930) 已支持每个 session 独立光标实例和颜色；[input.ts](../../extension/src/background/exec/input.ts#L1016) 的真实键盘输入依赖当前焦点，[domops.ts](../../extension/src/content/domops.ts#L203) 的滚动改变共享页面位置。

因此，现有工程已具备多 worker、分标签和多光标基础。缺的是用户会话层、严格的跨会话页面归属，以及同页协作的调度和事件分发。共享页应显式登记协作者，不能靠绕过普通认领规则形成。

## 推荐方向（待实验，不是实施授权）

### 不同会话：各用自己的页面集合

会话 A 与 B 各自持有任务、worker 与标签集合。实际需要浏览器时再创建标签组，不为纯聊天生成空白页。普通查找仅在自己的集合中进行；访问相同 URL 时可在各自组中新开页面。

“使用我正在填写的这份表单”则显式绑定原页，不能悄悄替换成同 URL 的新页。若已由另一任务使用，交给页内协作机制或明确等待，而不是抢走控制权。

### 同页协作：并行准备，短段协调写入

以简历为例，两个子 Agent 可同时读材料、推理并生成各自修改；分工绑定“工作经历”“教育经历”等实际字段/区块，不绑定会因排版改变的屏幕上下半部。

页面执行器调度一个完整短动作：重新定位并核对当前值 → 必要的滚动/聚焦 → 写入 → 读回验证。在这个动作完成之前，其他 Agent 不应插入会改变焦点、选区或滚动的操作。锁住单条 CDP 指令不够：`甲聚焦上栏 → 乙聚焦下栏 → 甲输入` 仍会输错。

等待模型思考时不占住页面。实际写入允许轮流发生，两个任务的准备工作继续并行。导航、重载、整页保存/提交属于影响全页的动作，应等相关编辑汇合后由明确负责人执行。

页面变动后重新核对定位和原值，避免使用另一 Agent 修改前的旧截图/坐标；失败报告已发生的修改，不假定动作可以数据库式回滚。若编辑器有经验证的按区块更新接口，可再研究更细粒度并发，不能对任意网站承诺。

每个子 Agent 可保留自己的彩色光标/标记；工作中、等待输入、完成必须来自真实状态。不能用同时移动的光标假装页面在同时接受两套独立键盘输入。

## 能推翻方案的最小实验

以下是后续实验建议，尚未运行，也不是已锁定的实现验收卡：

- A 在页一执行时新建 B、访问同 URL 的页二；A 不停，B 的导航/中止不改变 A。
- 一份仅在页内保存草稿的简历，由两个子 Agent 分别填不同字段；最终值正确，未开第二份简历，颜色能对应实际写入者。
- 人为交错聚焦和输入，确认未经协调会输错；加入短动作调度后同一路径不再串字段。
- 甲准备点击时乙引发布局变动；甲重新定位或拒绝旧目标，不点错。
- 两人都请求保存、其中一人尚未完成；不提前提交，不重复提交。
- 用户接管共享页时该页全部写入者停止；其他会话的独立页面不因此停下。

本轮证据是官方文档、上游 helper 源码、本机技能文档及当前产品代码静态审查。未证明真实网站下的吞吐、自动保存兼容性或视觉体验。
