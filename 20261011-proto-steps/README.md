# 过程块 · 三种改法（原型）

打开 `index.html`（本机 file:// 即可）。上排换「现状 / A / B / C / AC」和「顺利 / 中途出错」，中排播放、拖时间，下排一键跳到：运行中、思考中、一步做完、写回答前、完成·收起、完成·展开（出错那组：出错那一下、换办法、完成·展开）。侧栏里的那一行可以直接点开、收起。

- 侧栏宽 380px。样式是仓库 `extension/src/sidepanel/styles.css` @ `6a8587b` 原样复制成 `product-styles.css`，原型只在 `proto.css` 里加东西，只用已有 token（`--text-*`、`--content-*`、`--apple-*`、`--fs-*`、`--e-spring-run`）。
- 结构沿用产品：`details.run-steps > summary > .run-title(.act-verb/.act-object) · .run-time · .run-chevron`，`.run-reveal > .run-body`。进行中扫光 `runShine`、新字淡入 `reveal-fade`（300ms 透明 + 2px 模糊）、展开弹簧 `--e-spring-run`、滚动渐隐 `.scroll-fade`、每句至少停 1.1 秒（`RUN_TITLE_HOLD_MS`），都用产品自己的。
- 模拟的是一轮真实任务：打开 Studio Ghibli 词条，列出宫崎骏导演的电影。共 1 分 2 秒，6 件事，中间想了 40 秒和 6 秒。时钟按真实秒数走；播放时动手 1.8 倍速，长思考快进 16 倍（录像右上角会标「思考快进 ×16」）。
- 没改产品代码，没推送。`git status` 干净。

## 文件

| 用途 | 路径 |
|---|---|
| 可点原型（含切换） | `index.html`（`runs.js` 时间表 · `proto.js` 四种渲染 · `app.js` 页面 · `proto.css`） |
| 录像，顺利那轮（2x，760×1440，30fps，约 14 秒） | `videos/A.mp4` `videos/B.mp4` `videos/C.mp4` |
| 录像，中途出错那轮（点「作品」没找到按钮，改成滚过去找） | `videos/A-err.mp4` `videos/B-err.mp4` `videos/C-err.mp4` |
| 每种一张静图（运行中 / 思考中 / 一步做完 / 出错 / 完成·收起 / 完成·展开） | `stills/A.png` `stills/B.png` `stills/C.png` |
| 对比图：现状复刻 + A/B/C，同一时刻四列 | `stills/compare.png`（顶上附你的截图 `stills/current-screenshot.png`） |
| AC（选定组合）：录像 / 静图 / 对比 | `videos/AC.mp4` `videos/AC-err.mp4` · `stills/AC.png` · `stills/compare-AC.png` |
| 重新出图 / 录像 | `node tools/shoot.mjs stills [AC]|compare|compare-ac` · `node tools/record.mjs AC ok|err` |

## 第一步：别人怎么显示 agent 在干活

开源代码在本机：`/workspace/bys-sidebar-oss/repos/{whirl,ai-elements,assistant-ui}`、`/workspace/bys-proto-steps/refs/{open-webui,lobe-chat}`（这轮浅克隆）。

1. **只留一行「现在在做什么」，每句停够久，做完收成「做了 N 件事」。** Whirl `apps/v2/components/thread/phase-activity.tsx` L104–108（一轮只有一个活动面，回答出来后多步收进 “Did N things”）、L168；`apps/v2/lib/use-phase-narration.ts` L7 `PHASE_HOLD_MS = 1100`。ChatGPT agent 官方说法是 “on-screen narration”（openai.com/index/introducing-chatgpt-agent）。Hermes Agent PR #72893：一轮的工具活动收成「一行滚动播报」，结束时这一行变成摘要，点开才是逐条。
2. **思考时间单独算、照实写。** ai-elements `packages/elements/src/reasoning.tsx` L55 `AUTO_CLOSE_DELAY = 1000`、L164 “Thought for {duration} seconds”；Whirl `apps/v2/lib/phase-activity.ts` L118–125；Open WebUI `src/lib/components/common/Collapsible.svelte` L82–90；LobeChat `src/features/Conversation/components/Thinking/Title.tsx` L22–28（想的时候扫光字，想完写秒数）；assistant-ui `elements/reasoning.tsx` L173。Cursor 也是「Thought for Ns」一块、「Explored N files」一组（论坛截图描述）。没有一家把想的时间摊到每个工具上。
3. **最新状态当标题，历史收在后面。** Open WebUI `src/lib/components/chat/Messages/ResponseMessage/StatusHistory.svelte` L21–23、L33–45：`history.at(-1)` 就是那颗按钮，全部历史点开才有。
4. **三种墨色分状态，不靠图标。** ai-elements `chain-of-thought.tsx` L108–114：进行中 = 正文色，做完 = 灰，没开始 = 更淡。assistant-ui `elements/tool-group.tsx` L50–54 进行中写「已完成/总数」，单步耗时只在展开里出现（L112–119）。
5. **清单式进度（Manus、Cursor 待办「N/M」）要先有计划才成立。** By Your Side 是边看边做，事先没有步骤表，这一条不搬。

没实测：Claude、Perplexity / Comet、Manus 的线上界面这轮没登录去看，上面只引开源代码和官方文字。

## A · 一行「现在」+ 收起的记录

- 用户：看着助手在网页上干活的人
- 场景：任务跑了一分钟，中间有 40 秒在想
- 需求：一眼知道它现在在干什么，卡没卡住
- 问题：现在的块把状态和进度挤在一行，「执行脚本 0.0s」看不懂，想的 40 秒看不见
- 方案：第一行只写现在（「正在打开 Studio Ghibli 词条」，想的时候「正在思考 18 秒」）；第二行小字「已做 2 件事 ›」；做过的事默认收起，点开是人话记录，超过 3 秒才写秒数，最后一行「共 1 分 2 秒，其中想了 49 秒」

一句话：状态在上、进度在下，两行分开；收尾仍是「做了 6 件事 ›」。出错时第一行橙色写「没找到按钮，改成滚过去找」，记录里那步是红 ✕ 加原因，收尾写「做了 6 件事 · 1 件换了办法」。

## B · 紧凑时间线，现在在最底下

- 用户：看着助手在网页上干活的人
- 场景：任务跑了一分钟，中间有 40 秒在想
- 需求：看出时间花在哪：在想，还是在动手
- 问题：现在每步都写 0.0s、总共却 1 分 2 秒，想的时间没处放
- 方案：顶上一条按时长分段的细条（浅段 = 想，深段 = 动手）加总时长；下面像日志往下长，最近两件淡出，最底下一行是现在、墨色扫光；收尾成「做了 6 件事 ▬ 1 分 2 秒 ›」，展开末行「想 49 秒 · 动手 13 秒」

一句话：时间最诚实的一版，进行中多露两行。收尾行带总时长，和 10-06「耗时挪到回答下面」的决定冲突。

## C · 一串胶囊，收尾收成一行回执

- 用户：看着助手在网页上干活的人
- 场景：任务跑了一分钟，做了 6 件事
- 需求：不想读日志，扫一眼就知道做到哪了
- 问题：现在三行竖排小字加一条线，看着散
- 方案：现在一行在上；做完的事变成短胶囊从右边推进来（「打开词条」「读作品表 4 秒」，想的那段是虚线胶囊「想 40 秒」），放不下就把旧的推出左边；收尾整排收起，变成「做了 6 件事：打开词条 → … → 圈出 11 部 ›」

一句话：最紧凑、最好扫，但胶囊形状接近 10-06 去掉的那批，每个工具还要另写短名。

## 推荐：A

- 五个毛病都解决了：不说「执行脚本」；想的时间照实写（进行中「正在思考 18 秒」，展开末行「其中想了 49 秒」）；状态和进度分两行；最新的就是第一行；只剩一行墨字、一行小灰字，没有竖线、对勾、秒数列同时出现。
- 和已定的东西一致：过程行 A 的同一个 summary、扫光、细线、「做了 N 件事 ›」回执都不动，耗时也不回到回执上。改动集中在 `steps.ts` 的 `betweenStepsTitle` / `recentSteps` 和 `main.ts` 的 `renderTrail`。
- B 可以借一点：如果以后要更直观地看时间，把 B 那条细时间条只放进 A 的展开里，不放在常显的那行。

## AC · 进行中像 A，收尾像 C（用户选定）

- 用户：看着助手在网页上干活的人
- 场景：任务跑了一分钟，中间想了 40 秒，做了 6 件事
- 需求：跑的时候知道它在干什么；跑完扫一眼知道做了哪些事
- 问题：现在的块状态和进度挤一行、「执行脚本 0.0s」看不懂、想的时间看不见；收尾「做了 6 件事 ›」又什么都没说
- 方案：进行中同 A——第一行写现在（「正在打开 Studio Ghibli 词条」「正在思考 18 秒」），第二行小字「已做 2 件事 ›」，点开是人话记录、超过 3 秒才写秒数；做完收成一行回执「做了 6 件事：打开词条 → … → 圈出 11 部 ›」，不写耗时；点开是 A 的记录，末行「共 1 分 2 秒，其中想了 49 秒」

做法细节：
- 回执的短名链按侧栏宽度从中间省略：先试全部，放不下就头尾各留、中间「…」，一次少一个；头尾两个都放不下时只留最后一件（「… → 圈出 11 部」），再不行只写「做了 6 件事」。380px 下顺利那轮是「打开词条 → … → 圈出 11 部」。
- 出错那轮：回执末尾「· 1 件换了办法」不省略，短名链先让位：「做了 6 件事：… → 圈出 11 部 · 1 件换了办法 ›」；展开里那步红 ✕ 加原因。
- 进行中不加胶囊：第二行「已做 N 件事」已经说了进度，再排一行胶囊会吵，守 10-06 的决定。
- 文件：`videos/AC.mp4`、`videos/AC-err.mp4`、`stills/AC.png`（七个状态，含出错那轮收尾）、`stills/compare-AC.png`（现状 vs AC，五列：思考中 / 写回答前 / 完成·收起 / 完成·展开 / 出错·完成展开）。代码：`proto.js` 的 `receipt()` 与 `MOUNTS.AC`，样式在 `proto.css` 末尾。

### AC 落地要改的

1. **工具给短名。** 每件事要有两种说法：记录里的人话（「读出作品表，共 26 部」）和回执里的短名（「读作品表」，4–5 个字）。
   - 有参数能拼的直接拼：`navigate`/`tabs open` → 「打开词条」或「打开 + 页面标题前几个字」（标题已由 `openedPageTitle` 取到）；`click`/`fill` → 动词 +「label」（`actionCardLabel` 已有）；`mark` → 「圈出 N 处」。
   - `js` 只有 `code`（`shared/protocol.ts` L713），说不出在干什么：给它加一个必填的一句话用途（像 `browser_run` 的 `label`），由 `agent/src/tools.ts` L896 的工具说明要求模型写。没写时短名退回「查页面」，记录退回「在页面上查资料」，不再出现「执行脚本」。
   - `steps.ts` 里加 `shortAction(name, params)`，和 `pastAction` 并排；chip 上存 `data-short`，收尾 `finishRun` 用它拼回执。
2. **思考按段计时。** 现在只有整轮总时长（`spokenDuration(run.start, …)`）。要在思考开始/结束（`details.thinking` 出现与下一次 `tool_start`）各记一次时刻，存成一段段 `{start, end}`：进行中第一行用当前这段走秒（「正在思考 18 秒」），记录里每段 ≥3 秒单列「想了 40 秒」，末行合计「其中想了 49 秒」。历史回放没有可靠时钟时（`historyEventTime` 返回 NaN）就不写秒数。
3. **标题拆两行。** `betweenStepsTitle` 不再拼「· 已做 N 件事」；件数挪到 summary 第二行。`recentSteps` / `renderTrail` 的「+ 前面 N 步」和 0.0s 列删掉，过程只在展开里。
4. **收尾回执。** `finishedRunTitle` 改成回执：件数 + 短名链 + 可选「N 件换了办法」，中间省略在渲染时按宽度做（原型 `receipt()` 的做法），不写耗时。

## 落地前要补的（产品侧，原型里是写死的）

- 人话步骤名：`js` 工具现在只有 `code` 参数（`shared/protocol.ts` L713），说不出「读出作品表」。要让模型给 `js` 带一句用途（像 `browser_run` 的 `label`），没带时退回「在页面上查资料」，不再写「执行脚本」。
- 想的时间：要按思考事件的起止记时长，现在只有整轮的总时长。
- 秒数门槛 3 秒、思考少于 3 秒不单列：原型里是常量 `SHOW_SECS`、`THINK_MIN`（`proto.js` 开头）。
- 「现状」那行照你的截图写 0.0s；真实产品里是按 `formatDuration` 写的。
