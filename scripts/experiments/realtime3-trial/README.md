# Realtime 3 独立试用

这是保留研究证据的隔离入口，不是另一个日常版本。日常语音已统一为 3，见 `docs/STATUS.md`；本启动器也直接复用生产 `RealtimeVoiceConnection`，不再维护另一条默认语音实现。实验前端仅注入 `out/experiments/.../extension` 副本，不改生产构建。原 `voice-server.mts` 保留为首次试用代码历史，不再由启动器加载。

## 启动

在项目根目录、已有 `STEPFUN_API_KEY` 的终端运行（不要把密钥写进命令或文件）：

```sh
node --import tsx scripts/experiments/realtime3-trial/start.mts --visible --out out/experiments/realtime3-trial-next
```

`--headless` 是无窗口、静音检查；两者必须明确选择。浏览器默认使用 `out/experiments/realtime3-browser/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`，可通过 `EGO_ACCEPTANCE_CHROME` 指向已有测试浏览器。不会偷偷下载或切换日常浏览器。启动状态在所选目录 `ready.json`，失败和关闭记录也在那里。

## 使用

- 在独立窗口打开网页，右侧顶部为「Realtime 3 · 独立试用」。
- 点「开始交谈」。第一次会打开现有麦克风授权页；点击授权、按 Chrome/macOS 提示允许，完成后返回侧栏再点开始。打开窗口本身不录音、不连接语音模型。
- 可问页面内容、翻译网页或调整翻译显示；任务仍由原模型执行，底部任务模型名不是语音模型名。
- 「只停说话」不取消任务；「结束通话」释放麦克风和声音，后台任务仍能完成。原任务的暂停/终止使用原侧栏控制。
- 提交、付款、任意脚本和表单写入在试用宿主被硬阻断，不通过口头确认解锁。它不是完整产品权限接入。
- 转写与计时折叠在顶部。计时从服务端检测到说话结束算起，不能冒充真人说完到听见的精确测量。
- 不保存原始音频；隔离目录保留任务与脱敏事件记录。结束整个试用在启动终端 Ctrl+C，或核对 `ready.json` 中 pid 对应本启动命令后向该进程发送 SIGTERM；不要终止日常 agent 或 Chrome。

## 验证边界

首次交付的实际 3 连接、文字输入产生语音、真实翻译及结束通话后任务完成证据保留于 `docs/evals/20260920-stepaudio3-trial.md`。用户后来认可试用并决定迁移；日常版本证据见 `docs/evals/20260920-realtime3-daily.md`，不能把历史检查或合成声音当作日常真人声学验收。旧比较脚本和研究均保留。
