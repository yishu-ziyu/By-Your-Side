# By Your Side 功能一览：实拍展示页

## 结论

- 交付物：`/Users/mahaoxuan/firstmate/data/bys-features-r1/showcase/index.html`，双击就能打开，不需要服务器。图片放在同目录的 `img/` 下，共 51 张 JPEG，约 3 MB。
- 页面共 19 个功能区块，最后一节是「接下来已准备好可以做的」。每个区块依次写：你做什么、你看到什么、状态、至多一行已知问题（带证据出处），然后是空闲、进行中、结果、出错各状态的实拍图。
- 状态统计：可用 10 项（对话读页、模型设置、圈画、整页翻译、选中追问、点选元素、生成文件、多会话、阅读外观、小伙伴 M）；部分可用 6 项（操作网页、页面上确认危险动作、请求授权、停止与接管、语音、附件与截屏）；未完成 3 项（示范给 AI、技能与记忆、指导我操作）。
- 所有截图都来自真实构建的扩展界面，没有做任何示意图。模型回复和语音服务换成了本机脚本，每张图下都标了来源。

## 做了什么

1. 在 worktree（`0c40421`，HEAD 干净）运行 `npm ci`，然后执行 `SIDEAGENT_BUILD_DIST=$PWD/scratch/ext node extension/build.mjs` 构建扩展，产物放在 scratch 里。删掉了 manifest 的 `key`，所以扩展 ID 是随机的，连不上本机伴随进程，也碰不到日常的 `extension/dist`。
2. 自己启动 Playwright 自带的 Chrome for Testing 149：`--headless=new`，用户数据目录在 `scratch/profile`，加载 `scratch/ext`。没有接触你的日常 Chrome、Cookie、登录状态，也没有读 `~/.sideagent` 或任何 API key。
3. 页面素材：`scratch/servers.mjs` 在 `127.0.0.1:8731` 提供页面，内容原样取自仓库的真实路径夹具 `scripts/acceptance/real-path/everyday-baseline.mts:44-80`。
4. 模型：同一个脚本在 `127.0.0.1:8732` 起了一个 OpenAI 兼容的脚本模型，按关键词返回写好的回复和工具调用（`scratch/rules.mjs`）。配置方式和陌生人一样：打开真实设置页，选「自定义地址」，填地址、key `local-demo-no-secret`、模型 `demo-model`，测试连接后保存。因此工具调用、宿主核验、账本、页面标注都是产品自己的逻辑在跑。
5. 语音：`scratch/fake-voice.mjs` 在 `127.0.0.1:8743` 模拟实时语音协议，有 `session.created/updated`、转写、`audio_transcript.delta`、`response.done`。用 `--host-resolver-rules` 把 `api.stepfun.com` 映射到本机后，HTTPS 能通，WebSocket 不通（关闭码 1006；直连 IP 能通）。所以只在 scratch 的构建产物 `ext/inproc.js` 里把 `wss://api.stepfun.com/v1/realtime` 换成本机地址。源码没改，页面上也写了这一点。设置页的语音 key 填的是假值 `local-demo-voice`。
6. 浏览器驱动：用 `chrome-devtools-axi`（`CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9377`）连接并打开成品页检查。打开侧栏需要带用户手势的 `chrome.sidePanel.open`，截图时还要逐个目标设 2 倍像素比，axi 做不到这两件事，所以另写了 CDP 小驱动 `scratch/drive.mjs`，沿用仓库的 `scripts/acceptance/cdp.mjs`。侧栏截图是真侧栏目标（360×765，2 倍），不是标签页里打开的 sidepanel.html。
7. 成品页用 axi 打开核对：51 张图全部解码成功（`decode()` 失败 0 张），版式抽查了顶部、圈画、语音三段。

没有提交、推送，也没有修改任何被跟踪的项目文件。所有临时文件都在 `scratch/`，worktree 回收时一起清掉。

## 每张图怎么来的

来源标记三类：「实拍」指真实界面加真实本地状态；「实拍 · 模型回复由本地脚本提供」指界面是真的，模型是脚本；「实拍 · 语音服务为本地模拟」指界面是真的，语音服务端是脚本。

| 图片（img/） | 操作 | 来源 |
|---|---|---|
| chat-1-idle, chat-2-waiting, chat-3-answer | 新会话 → 在 /article 页问「这篇文章的核心观点是什么？」，发送后 0.9 秒截一张，完成后再截一张 | 空闲图为实拍，其余为脚本模型 |
| chat-4-error | 问题带「报错演示」，脚本模型对每次请求都回 503 | 脚本模型 |
| model-1-none | 还没配模型时直接发消息 | 实拍 |
| model-2 ~ model-6 | 「更多」菜单、设置页选服务商、填自定义地址后保存、侧栏模型菜单、设置页下半（音色、人设、诊断记录） | 实拍 |
| mark-1 ~ mark-4 | 在 /quota 说「在页面上圈出五小时用量。」，脚本模型调用 `mark`（target 加 through），最终回答延迟 9 秒，以便截到进行中状态 | 脚本模型 |
| tr-1 ~ tr-3 | 在 /en 说「把这页翻译成中文。」，脚本模型调用 `page_translation`，扩展的翻译请求由脚本按段落返回中文 | 翻译前为实拍，其余为脚本模型 |
| tr-4-not-effective | 第一次跑时脚本返回的译文格式不对，产品如实写「页面没有变化」 | 脚本模型 |
| ask-1-open, ask-2-answer | 在 /article 选中第二段，从侧栏向页面发 `{type:"ask-hotkey"}`（后台收到 ⌘J 命令后发的就是这条消息，无头浏览器收不到快捷键），然后提问 | 打开卡片为实拍，回答为脚本模型 |
| act-1-running | 在 /compose 说「帮我改错字，然后点发送。」：脚本模型先 `fill`，再 `click` 发送键 | 脚本模型 |
| act-2-unfinished | 「圈出五小时用量和「升级套餐」按钮」，脚本模型回 `send_user_message` partial | 脚本模型 |
| act-3-tab-busy | 在上一个会话留着「待确认」的同一个标签页里新开会话继续操作，工具返回「该页正在由其他会话使用」 | 脚本模型 |
| confirm-1 ~ confirm-3 | 发送键被拦下来等确认；运行中点页面上的「发送」，表单提交到 /save；另一轮在结束后截页面 | 脚本模型 |
| consent-1, consent-2 | 脚本模型调用 `fetch` POST `https://report.example.com/api/weekly`，展开发送内容后点「拒绝」，请求没有发出 | 脚本模型 |
| point-1 ~ point-3 | 脚本模型调用 `ask_user_to_point`，鼠标悬停后点「$12.40」 | 脚本模型 |
| stop-1 ~ stop-4 | 「这是一个很长的任务……」，脚本模型挂起 60 秒；分别按停止键和「接管」 | 脚本模型 |
| voice-1 ~ voice-3 | 设置页填假语音 key，点语音键，模拟服务 6 秒后发一句转写和一段回答 | 语音服务为本地模拟 |
| voice-4-nokey, voice-5-mic, voice-6-conn-error, voice-7-permission-page | 没填语音 key；未授权麦克风（第一次启动 Chrome 时没加假设备参数）；地址映射后连接失败；点语音键后打开的授权页 | 实拍 |
| file-1-card | 在 /products 说「把这页的商品和价格导出成 CSV。」，脚本模型调用 `artifacts create` | 脚本模型 |
| attach-1, attach-2 | 「+」→「截取当前网页视口」 | 实拍 |
| conv-1-list, read-1-settings, demo-1, demo-2, mem-1, mem-2 | 会话下拉、阅读外观、示范给 AI（在 /note 输入并保存，再点「编译成脚本」）、技能与记忆 | 实拍 |

原始 PNG 在 `scratch/shots/`，导出脚本是 `scratch/export.py`（负责裁剪和压缩），页面由 `scratch/gen.py` 生成。

## 本次实拍发现、用户看得见的问题

以下都来自本次截图，可以重复验证：

1. **报错又慢又生硬**：模型持续返回 503 时，约 29 秒后才显示出错（脚本日志里 5 次请求的时间是 0 / 14.8 / 16.8 / 20.8 / 28.8 秒）。回答区写「任务状态：仅交付部分结果」，下面贴出原始 JSON `503: {"message":...}`（chat-4-error）。
2. **内部名字露在界面上**：「正在执行 · fetch」「正在ask_user_to_point」「有 1 步没做成：fetch」「有 2 步没做成：填写 @1443」（consent-1、point 过程行、consent-2、act-3-tab-busy）。
3. **拒绝授权被当成失败**：点「拒绝」后显示「执行失败」「仍有步骤执行失败」，还给了「继续」按钮（consent-2-denied）。另外，授权卡里的发送内容以 URL 编码原样显示。
4. **页面上的确认会消失**：发送键被拦下后，这一轮一结束，页面上的「发送 / 取消」就收起了，只剩「待确认」名牌，点它没有反应（confirm-3-after-run）。前提说明：是脚本模型在等你确认时结束了这一轮。真实模型会不会同样结束这一轮，没有验证。
5. **留着待确认动作的会话会占住标签页**：新会话在这一页操作会失败，只显示「执行失败 / 页面没有变化」（act-3-tab-busy）。
6. **未配置模型、附上截图时任务卡显示内部占位**：「（目标未记录）」「新任务」「材料」「待发送材料」（model-1-none、attach-2-added）。
7. **语音面板的文字问题**：麦克风未授权时，右上角「停声」和「开启麦克风」叠在一起（voice-5-mic）；连接失败的文案是「语音服务连接出错：语音服务连接出错」（voice-6-conn-error）；没填 key 的提示写「本机 StepFun 开放平台 API Key」，没有指向「更多 → 模型与语音」（voice-4-nokey）；就绪时状态文字是「Realtime 3 已连接」（voice-1-ready）。
8. **选中追问卡片会跳位**：卡片先出现在选区上方、盖住标题，提问后跳到选区下方（ask-1 → ask-2）。
9. **小伙伴 M 挡按钮**：接管时挡住「详情」，示范里挡住「编译成脚本」（stop-3、demo-2）。
10. **只装扩展时，记忆和技能不能用**：显示「记忆存储不可用」「编译没成：技能存储不可用」（mem-2、demo-2）。路线图已经暂停这两项（`docs/ROADMAP.md:17`），但入口仍在「更多」菜单里。

第 2、3、5、6 条和 `docs/evals/20260925-artifacts-files.md:25` 已记录的「误报仅交付部分结果」同属一类：宿主的核验和账本文字直接漏到了用户面前。这类问题适合放进 STATUS 下一步第 1 项「错误分析」的错误清单统一处理。它们都有稳定的复现步骤（上表），可以直接当作错误清单的首批条目。

## 状态判定依据

| 功能 | 状态 | 依据 |
|---|---|---|
| 对话读页、模型设置、诊断导出 | 可用 | `docs/STATUS.md:11`（日常底线 10/10），`docs/STATUS.md:21`（设置页到结果通过，日常纯扩展 10/10） |
| 圈画 | 可用 | `docs/STATUS.md:21`（阶跃 3/3）；耗时见 `docs/ROADMAP.md:18` |
| 整页翻译 | 可用 | `docs/evals/20260917-page-translation-reliability.md`，`docs/evals/20260925-artifacts-files.md` 日常底线 5/5 |
| 选中追问 | 可用 | `docs/evals/20260916-selection-reading.md:8-10`，外加本次实拍 |
| 点选元素 | 可用 | `docs/STATUS.md:15`（文字主会话通过；语音、接管等未验收） |
| 生成文件 | 可用 | `docs/evals/20260925-artifacts-files.md` 第 1–4 条通过 |
| 阅读外观、小伙伴 M、多会话 | 可用 | `docs/evals/20260913-reading-settings.md:18`，`docs/testing/acceptance.md:39`（companion-toggle），`npm run accept:sessions`，外加本次实拍 |
| 操作网页、停止与接管 | 部分可用 | `docs/STATUS.md:25`（改口、续接、接管交还仍有缺口），外加本次实拍第 2、5 条 |
| 页面上确认危险动作 | 部分可用 | 本次实拍运行中能确认并提交，结束后确认按钮消失 |
| 请求授权 | 部分可用 | 本次实拍：能拦下、能拒绝，但拒绝后的呈现不对 |
| 语音 | 部分可用 | `docs/STATUS.md:34`（阶跃傍晚 6 次卡住 4 次），`docs/ROADMAP.md` 第 7 条（发布阻断项） |
| 附件与截屏 | 部分可用 | 只实拍到附上截图，仓库里没找到发出后模型读图的近期验收 |
| 示范给 AI | 未完成 | `docs/evals/20260911-skill-from-demo.md:28`（第 5、6、9 条没过），`docs/ROADMAP.md:17` 已暂停 |
| 技能与记忆 | 未完成 | `docs/ROADMAP.md:17` 已暂停；只装扩展时存储不可用（本次实拍） |
| 指导我操作 | 未完成 | `docs/evals/20260907-hand-drawn-teach-marks.md:11`（真机裁决未过）；当前使用说明未提及；本次没有实拍到效果 |

## 「接下来已准备好可以做的」取自哪里

只收仓库文档里已经写成下一步的项，没有另外编计划：

1. 错误分析：`docs/STATUS.md:33`，`docs/ROADMAP.md` 第 7 条。
2. 语音服务对比实验：`docs/STATUS.md:34`。
3. 按错误清单修，并验证陌生人能自己安装、配置：`docs/STATUS.md:35`。
4. 在日常 Chrome 重载后复验扩展内核心的那批修复：`docs/STATUS.md:21`。
5. 网页文件在侧栏里预览：`docs/evals/20260925-artifacts-files.md:13`，文档标注为「第二步，未做」。

页面同时注明：暂停项（`docs/ROADMAP.md:17`）和等权限决定的 C3 下载（`docs/STATUS.md:14`）不在这张清单里。GitHub 上 3 个 open issue（#1、#2、#4）都是 18 天前的，没有标为「就绪」，所以没有列入。

## 局限

- 模型和语音是脚本，所以图里回答的内容和耗时不代表真实模型的质量和速度。真实耗时只引用仓库的验收记录。
- 语音点阵球的动效、真实说话时的「正在听你说」、插话停声都没有拍到真人输入下的样子。
- 侧栏和页面是分开截的两张图（无头浏览器拍不到整窗），放在同一节里并排展示。
- 「指导我操作」没有实拍。
- 发现 4 依赖「这一轮在等确认时结束」这个前提，真实模型下是否一样没有验证。

## 建议

- 首次打开页面时，建议先看「替你操作网页」「页面上确认」「请求授权」「语音」这四节，部分可用项集中在这里。
- 上面实拍发现的第 1–6 条，建议作为错误分析计分板的首批已确认错误。它们不需要新调研，每条都有复现步骤。第 7–9 条是界面细节，改动范围小。
- 这些改动还没有立项；要不要修、先修哪条，按 STATUS 已定的顺序（先做错误分析）决定，本报告不另行排期。
