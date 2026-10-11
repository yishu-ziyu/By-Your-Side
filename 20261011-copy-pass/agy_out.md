| 文件:行号 | 原文 | 问题类型(1-5) | 一句话说明 |
| :--- | :--- | :---: | :--- |
| sidepanel/task-bar.ts:436 | `TaskBar 需要 document（或注入 doc）` | 3 | 开发断言与底层代码报错直接泄漏在用户界面 |
| content/edge-pill.ts:44 | `<style>${STYLE}</style><div class="wrap" role="status"><div class="pill"></div><div class="card"><div class="state"></div><div class="goal"></div>` | 3 | 未经渲染的 HTML/CSS 模板代码直接暴露在界面中 |
| content/cursor.ts:187 | `.cursor { position: absolute; top: 0; left: 0; transition: opacity 160ms ease; } /* 常驻的光标闲置时不长期占用独立合成层。 */ .cu` | 3 | CSS 样式定义及内部技术注释直接作为文案显示 |
| sidepanel/voice-ui.ts:13 | `<canvas class="voice-orb" aria-label="语音光球"></canvas><button class="voice-end" type="button">结束</button><div class="voice-state" role` | 3 | 原始 HTML 标签代码泄漏在前端界面文案中 |
| sidepanel/error-card.ts:235 | `<summary>技术详情</summary><pre></pre>` | 3 | 裸露的 HTML 标签未经处理直接输出给用户 |
| background/index.ts:1491 | `TAB_OWNERSHIP_ERROR: 该页面不属于当前会话` | 3 | 直接向用户展示内部大写错误码与程序异常枚举名 |
| sidepanel/main.ts:3895 | `交给你期间，我不读也不动这个页面。` | 5 | 写死绝对承诺，若后台存在页面感知或状态监控机制则与实际不符 |
| sidepanel/resume-entry.ts:215 | `后台刚重启。原页面还开着的话，我会自动接着做，已完成的步骤不会重做；没有动静就点「继续原任务」` | 5 | 既断定会自动接着做，又要求无反应时手动点击，前后状态逻辑冲突 |
| background/index.ts:340 | `麦克风还没授权，已打开授权页。` | 5 | 写死“已打开授权页”，若遭遇浏览器弹窗拦截或打开失败则与实际不符 |
| background/index.ts:846 | `连接中断，交还没有完成，页面仍归你。` | 5 | 连接已中断时无法确认服务端实际状态，断言“页面仍归你”可能失真 |
| background/index.ts:1565 | `本地已接管。Agent 未连接，页面写入已停。` | 5 | 未连接状态下断定“页面写入已停”，可能与实际前端运行情况脱节 |
| background/send-confirm.ts:40 | `用户停下了任务或接管了页面：没有点「发送」，草稿还留在页面上。${NO_OTHER_WAY}` | 5 | 写死“草稿还留在页面上”，若页面发生跳转或刷新草稿已丢失 |
| settings/main.ts:513 | `已登录，令牌会自动续期。` | 5 | 写死会自动续期，若长久未操作或服务商授权撤销将无法续期 |
| settings/main.ts:902 | `已保存。按住说话的事做完会念出结果。` | 5 | 写死后续必然念出结果，忽略了语音服务不可用或配置失效的情况 |
| sidepanel/error-card.ts:155 | `网络恢复后会自动重试一次，不用盯着。` | 5 | 写死自动重试承诺，若错误为鉴权失败或模型欠费则不会成功重试 |
| content/ptt-capsule.ts:145 | `交给助手了` | 5 | 发送动作未确认对端接收即断言已交付，网络异常时状态不实 |
| content/cursor.ts:1260 | `好像没有生效：点了之后页面没有变化。再点一次试试；还不行就告诉我。` | 5 | 页面可能处于异步网络等待中，断言“没有生效/没有变化”不准确 |
| sidepanel/open-threads.ts:357 | `原页面已经找不到了` | 5 | 页面可能只是被最小化、移到其他窗口或暂未加载，断言找不到过于武断 |
| background/index.ts:1332 | `操作所属控制轮次已失效，操作未执行。` | 3 | 使用“控制轮次”等内部调度协议术语，普通用户无法理解 |
| background/index.ts:1412 | `worker 已停止，操作未执行` | 3 | “worker”为后端进程与线程开发概念，非用户界面语言 |
| background/index.ts:1385 | `未知工具: ${String(name)}` | 3 | “工具”为 AI 代理开发内部词（Tool Call），对用户表意模糊 |
| background/index.ts:1573 | `正在读取绑定页，请稍候。` | 3 | “绑定页”属于扩展内部架构术语，用户不清楚指哪个页面 |
| sidepanel/resume-entry.ts:29 | `任务中断在检查点，等你说继续` | 3 | “检查点”为容灾备份技术术语，普通用户难以理解其概念 |
| sidepanel/resume-entry.ts:30 | `已按你的要求停止，不会自动复活` | 3 | 使用“复活”等底层进程恢复的开发俚语，不符合产品文案规范 |
| sidepanel/resume-entry.ts:33 | `有操作结果未知且缺少可对比基线，不会自动重做` | 3 | “可对比基线”为测试与算法对比术语，用户认知门槛高 |
| sidepanel/resume-entry.ts:40 | `与伴随进程的连接断开` | 3 | “伴随进程”（Sidecar Process）为系统架构内部术语 |
| sidepanel/task-bar.ts:36 | `伴随进程当时停止了` | 3 | 同样暴露了“伴随进程”这一内部工程构件名称 |
| sidepanel/resume-entry.ts:80 | `缺少原任务身份，不能续接` | 3 | “原任务身份”（Task Identity/ID）是数据层字段概念 |
| sidepanel/resume-entry.ts:235 | `请按阻塞说明继续。` | 3 | “阻塞说明”为任务调度与流水线工程词汇 |
| sidepanel/steps.ts:56 | `请了人` | 3 | 用“人”指代子代理或并发线程，内部比喻晦涩古怪 |
| sidepanel/steps.ts:57 | `名册` | 3 | 用“名册”指代子任务/子代理清单，属于内部隐喻 |
| sidepanel/steps.ts:59 | `投递工件` | 3 | “工件”（Artifact）为编译与软件工程专业词汇 |
| sidepanel/steps.ts:60 | `等待工件` | 3 | 继续使用工程化词汇“工件”，未能表达具体的产出内容 |
| sidepanel/task-bar.ts:31 | `上一步工具失败` | 3 | “工具失败”直接暴露了代理调用底层工具的概念 |
| sidepanel/task-bar.ts:790 | `+${this.view.revisions.length} 修订` | 3 | “修订”属于版本控制术语，在日常任务中含义不直观 |
| sidepanel/main.ts:259 | `伴读导轨` | 3 | 属于内部产品功能代号，未向用户传达实际用途 |
| sidepanel/main.ts:279 | `当前活动标签页检查器` | 3 | “检查器”为开发者工具词汇（Inspector） |
| sidepanel/main.ts:285 | `状态：活跃连接已就绪` | 3 | 系统底层连接通信状态直白暴露在主界面 |
| sidepanel/main.ts:310 | `段落提示模式` | 3 | 机械堆砌技术名词“模式”，含义抽象 |
| sidepanel/main.ts:329 | `发出插话（Enter）` | 3 | “插话”（Barge-in）为双工语音通信技术协议词 |
| sidepanel/main.ts:683 | `页面起点探测超时` | 3 | “起点探测”为自动化操作内部流程阶段名称 |
| sidepanel/main.ts:2037 | `状态：${tab.status === "complete" ? "已就绪 (complete)" : "加载中 (loading)"}` | 3 | 将底层代码枚举英文值直接拼接入用户可见文案 |
| settings/main.ts:898 | `只接受 MiniMax Token Plan 的订阅 Key（sk-cp- 开头）。按量计费的 key 不能用。` | 3 | 充斥“Token Plan”等计费模式英文开发术语 |
| sidepanel/voice-ui.ts:146 | `导出JSON` | 3 | 直接使用数据格式英文缩写“JSON”，普通用户看不懂 |
| background/ptt-capsule.ts:134 | `页面交给你了，做完回侧栏点继续。` | 4 | 侧栏界面上实际对应按钮是「交还」，指向了不存在的操作按钮 |
| sidepanel/error-card.ts:184 | `key 只存在这台电脑。用账号登录的服务，也可以` | 4 | 语句在“也可以”处突兀中断，缺少后续指示，指代不清 |
| sidepanel/main.ts:1601 | `你在对话里说过的邮箱、姓名、偏好和带日期的安排会自动记在这里。关于你的每轮都会用上；带日期的到那天` | 4 | 文案在“到那天”处戛然而止被截断，指代与语意严重不完整 |
| settings/main.ts:141 | `用声音和助手交谈。语音对话使用阶跃星辰的实时语音。上面已经填了阶跃星辰的 key，这里就不用再填。` | 4 | 依赖视觉相对位置词“上面”“这里”，界面滚动或折叠后指向断裂 |
| settings/main.ts:445 | `没有找到「${query}」。OpenAI 兼容的服务可以用下面的「自定义地址」接入。` | 4 | “下面的「自定义地址」”在筛选结果或自适应布局中方位并不固定 |
| settings/main.ts:916 | `在下面选一个服务商，登录或填好 key 后保存。` | 4 | “在下面”方位指向不明，脱离视觉顺序易造成误解 |
| settings/main.ts:1057 | `用 ChatGPT 登录，不用阶跃星辰 key；要先在上面用 ChatGPT 登录。下次开启语音时生效。` | 4 | “在上面”具体所指区域不明 |
| settings/main.ts:71 | `主模型卡住或暂时出错时，换它接着做。对话内容会发给这一家。` | 4 | 连用代词“它”和口语“这一家”，在严肃设置项中指代含糊 |
| settings/main.ts:569 | `这家没有模型目录，直接填写模型名称。` | 4 | 口语化使用“这家”，指代具体哪家服务商不严谨 |
| settings/main.ts:723 | `已删除 key。主模型还是这家，填新 key 或换个模型后才能用。` | 4 | 同样使用“这家”代指服务商，指向不明 |
| sidepanel/main.ts:2768 | `这里别用` | 4 | “这里”指代范围不明（是指当前网页、当前输入框还是特定网站） |
| sidepanel/main.ts:1501 | `换成新值后，旧的留在这里，不再带给助手。` | 4 | “新值”“旧的”“这里”多个代词连续使用，指向极度含糊 |
| sidepanel/main.ts:1084 | `此后已更新。下方列表显示当前版本。` | 4 | “下方列表”脱离布局结构后可能并不在下方 |
| sidepanel/main.ts:135 | `回到页面上的第 ${n} 圈` | 4 | “第 n 圈”脱离具体元素定位语境，用户无法理解具体指代 |
| sidepanel/main.ts:140 | `原处已变化` | 4 | “原处”指向不明，未说明是网页结构、内容还是选区变化 |
| sidepanel/receipt-view.ts:60 | `连好以后，把刚才的话再发一次。` | 4 | “刚才的话”指向不明，多轮交互时易产生歧义 |
| sidepanel/resume-entry.ts:72 | `任务已停止，这个入口不会把它复活` | 4 | “这个入口”指代不明，未说明是哪一个按钮或面板 |
| background/reading.ts:85 | `阅读窗口过多，请先停止一个。` | 4 | “停止一个”未指明如何停止、在何处停止哪一个窗口 |
| background/reading.ts:117 | `这段阅读已较长，请在侧栏继续。` | 4 | “较长”标准模糊，去侧栏如何继续未给出明确指向 |
| content/cursor.ts:1269 | `这里不是要点的位置。请点圈出来的「${name}」。` | 4 | “这里”指代不明，未明确说明用户误点的是什么区域 |
| content/memory-mark.ts:131 | `。这一格是按这条填的。` | 4 | “这一格”“这条”代词含糊，脱离上下文指代不清 |
| sidepanel/delivery-facts-view.ts:85 | `已交付 · 来源 ${sources.length}` | 2 | “来源”指任务信息引用的网页证据源，与记忆条目的原话来源混淆 |
| sidepanel/main.ts:1257 | `查看来源` | 2 | 这里的“来源”指产生该记忆的用户对话原文出处，与任务引文来源同词异义 |
| sidepanel/main.ts:1050 | `忘记记录` | 2 | “记录”通常指日志流水，此处实际指代的是单条“记忆”，容易产生歧义 |
| background/reading.ts:121 | `阅读记录已较长，请在侧栏继续。` | 2 | 此处“记录”指划词问答的会话内容，与设置中的诊断日志“记录”概念不同 |
| background/index.ts:1004 | `${msg.action === "takeover" ? "接管" : "交还"}没有被 Agent 接受。` | 1 | 混用英文开发词“Agent”，其他多处文案均使用“助手” |
| background/index.ts:334 | `按住说话没有接上：助手还没启动好，稍后再试。` | 1 | 助手与 Agent 概念混用；且与后续第一人称“我”并存 |
| content/ask.ts:89 | `问 AI` | 1 | 划词菜单中使用“AI”，与全系统的“助手/Agent”概念不一致 |
| content/cursor.ts:782 | `我在点这里` | 1 | 突然改用第一人称“我”，与客观称呼“助手/Agent/它”不一致 |
| sidepanel/open-threads.ts:110 | `页面交给了你，它在等你接着说` | 1 | 采用第三人称“它”指代 AI，与“助手/我”人称代词分裂 |
| background/index.ts:105 | `页面现在归你，操作未执行` | 1 | 控制权交接状态文案在“页面归你”与“接管/交还”之间混乱混用 |
| sidepanel/main.ts:199 | `部分成员已恢复。未续跑的人仍归你。` | 1 | 将助手称为“成员/人”，并使用“续跑”，与其他界面的控制权词汇冲突 |
| background/index.ts:1743 | `终止请求未送达Agent。` | 1 | 混用“终止”，其他地方混用“停止”“中止”“停下”“停” |
| sidepanel/main.ts:3398 | `中止` | 1 | 独立使用“中止”，与系统通用的“停止/停下”不一致 |
| sidepanel/task-bar.ts:143 | `已请求停止：等 Agent 收手…` | 1 | 口语化使用“收手”，与标准动词“停止/停下”冲突 |
| settings/main.ts:209 | `密码和密钥已去掉` | 1 | 混用中文“密钥”，与其他界面的“key/API key/令牌”不一致 |

1. AI 实体：Agent / 助手 / AI / 我 / 它 / 成员 / 人
2. 控制权交接：交还 / 接管 / 页面归你 / 页面交给你 / 续跑
3. 停止动作：停止 / 中止 / 终止 / 停下 / 停 / 收手 / 暂停 / 停声
4. 密钥凭证：key / Key / API key / 密钥 / 令牌
5. 记忆删除：忘记 / 忘掉 / 删掉 / 撤销 / 停用
6. 交互单位：会话 / 对话 / 聊天
7. 屏幕截取：截图 / 截屏
8. 表单操作：填 / 填写 / 输入；点 / 点击 / 点按
9. 划词选取：划词 / 选择文字 / 选区
10. 任务单元：任务 / 事 / 步骤 / 工件
