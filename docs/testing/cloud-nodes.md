# 云电脑节点

全量真实路径验收在一台机器上要 30–40 分钟，所以用 `npm run accept:shard` 分到几台机器并行跑。本页写每台机器怎么连、怎么救活、踩过什么坑。节点表本身在 `scripts/acceptance/real-path/shard-run.mts` 的 `NODES`。

## 现有节点

| 名字 | 系统 | 规格 | 怎么连 | Chrome | 适合 |
|---|---|---|---|---|---|
| `local` | macOS | 本机 | 直接跑 | Chrome for Testing（Playwright 装的） | 有窗口的测试、OAuth 套餐的真模型用例 |
| `aliyun` | Linux | 2 核 3G | ssh `root@121.89.90.68` | Chrome for Testing（`/opt/chrome-for-testing/`） | 长任务；一直开机，最稳 |
| `grokbox` | Linux | — | ssh `box@100.124.81.45`（Tailscale 地址，普通 sshd） | Playwright 的 Chromium | 长任务；会休眠，见下文 |
| `devin` | Linux | 8 核 31G | `devin cloud drs run --devin-id <id>` | 正式版 `google-chrome` | 只接几分钟能跑完的短任务 |

动节点前先跑 `npm run nodes`：一次列出每台机器在不在线、开机多久、负载、可用内存、Chrome 在不在、残留的测试 Chrome，以及 grokbox 的保活还剩多久。不在线的节点用 `--skip=<名字>` 跳过，它分到的用例记为未跑，不算通过。

分片跑完，每个失败或未跑的用例下面有一行原因（失败取自用例日志，未跑写明是节点连不上、超时还是没交回结果）；每个节点的完整输出在结果末尾给出的 `out/acceptance/real-path/shard-<时间>/` 里。每个节点有时限（准备 5 分钟，加上每轮 6 分钟），卡住的节点到点记为超时，不会让整轮一直等。已知缺口：超时后只杀掉本机这一端，远端的测试和 Chrome 可能还在跑，下一轮前用 `npm run nodes` 看残留测试 Chrome。

残留测试 Chrome 不为 0 而又没在跑测试，说明之前有测试异常退出，它们会一直占内存和 CPU；确认没有测试在跑后再清理。

## 没接进分片的：Devin macOS 沙箱

沙箱 `9e409382c3cf4f709de662f933c2ff47`（macOS 26，8 核，蓝图装好了 Node 和正式版 Chrome）单个短用例能跑通，但还不能当分片节点：它每次被 `drs run` 叫醒都要重新开机，开机后负载上百，`/tmp` 清空；命令只要跑几分钟，就会超过服务端时限也不返回（10-19 连续两次卡到 600 秒）。下一步可以试 Devin 设置里的 SSH 登录（Settings → Devin → SSH access），绕开 `drs run`；通了再把它加回 `NODES`。

## 正式版 Chrome 和 Chrome for Testing 都能跑

用户用的是正式版 Chrome，所以验收必须在正式版上也能过。正式版 Chrome 会忽略 `--load-extension`，所以验收脚本启动时带 `--load-extension`（Chrome for Testing 和 Chromium 认它），连上后再用调试协议的 `Extensions.loadUnpacked` 装一次（正式版靠这一步）；旧版 Chrome for Testing 没有这个命令时就只靠启动参数。不要加回 `--disable-extensions-except`：它会把这样装入的扩展也禁掉，扩展页面变成错误页，症状是“等待超时：辅助页加载”。

本机想用正式版跑：`EGO_ACCEPTANCE_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npx tsx <用例> --headless`。

## grokbox（Grok Bot 云电脑）

- 只有 sun 在工作时 VM 才醒着。sun 一空闲，SSH 就连不上；自己经 ssh 挂的 sleep 不算。
- 唤醒和保活：驱动本机 Grok Bot.app（CUA 或 LCU）给 sun 发“运行 `bash ~/agent-data/bys-restore.sh`，然后前台 `sleep 2700`”，再用 ssh 确认 `pgrep -af "sleep 2700"` 有输出。实测从发消息到 SSH 连通 34 秒。sleep 到点后 VM 会睡，长任务要在到点前再发一次。
- 持久区是 `~/agent-data`。Node、Chromium、仓库依赖都放在 `agent-data/bys-persist`，家目录里只留软链；Tailscale 节点状态和 Mac 公钥也在那里留了副本，所以睡醒后地址不变。`bys-restore.sh` 可以重复运行。
- 没验证过：快照恢复把家目录清空以后，restore 脚本能不能把软链全补回来。到目前为止只遇到过暂停后醒来。
- Tailscale 自带的 SSH 每次登录都要在浏览器里再验证，脚本过不去，所以关掉了，改用普通 sshd。Tailscale authkey 只在 box 的 `agent-data/tailscale/`，不进仓库、不打印。

## Devin

- 环境蓝图的唯一来源是仓库里的 `.devin/blueprint.yaml`（Linux 和 macOS 两段）。改了以后用 `devin cloud drs blueprint-write --blueprint-id snapshot-blueprint-95d080e2a7a84431a8149c6f8cc5e714 --from-file .devin/blueprint.yaml` 写上去，再 `devin cloud drs build`。命令行读不出线上蓝图，所以不要只在网页上改。
- 它只看得到 origin 上推送过的代码：本机 HEAD 没推送时，分片脚本退回 `origin/main` 并在输出里标明。
- 沙箱只在一条 `drs run` 执行期间醒着；前台长命令十来分钟内会断开，后台进程跟着停。命令超时时 stdout 整个丢失，所以探测命令里每一步都要有时限。
- 新建 Linux 沙箱：`devin cloud drs sandbox-create --repo yishu-ziyu/By-Your-Side`，把新 id 填进 `NODES`。
- 新建 macOS 沙箱：`sandbox-create` 没有选系统的参数，只按组织默认系统起。要先在 Devin 网页 Settings → Devin → Default platform 改成 macOS，建完马上改回 Ubuntu。这是账号设置，要先问用户。沙箱建好后一直留在它开始时的系统上。
- 不要在 Mac 沙箱里用软链或往软链写文件来给 Chrome 换名字：Chrome 按启动路径找自己的框架文件，软链启动会崩；往软链写转调用脚本会顺着软链覆盖掉 Chrome 本体（10-19 实际弄坏过一次，用 `brew install --cask --force google-chrome` 修好）。

## 阿里云

一直开机、不休眠，是最稳的节点；但机器小，分片只让它一次跑 1 个用例。它偶尔在 SSH 握手阶段直接断开（sshd 日志里没有记录，10-19 连 5 次断 1 次），所以 SSH 都复用同一条连接（`scripts/acceptance/nodes.mts` 的 `SSH_OPTS`），失败会重试。这台机器开着密码登录，日志里一直有陌生 IP 在猜密码（10-19 三小时 39 次）。

## 推送和凭据

- 从 Mac 用 tar 推文件要带 `COPYFILE_DISABLE=1`，否则 macOS 的 `._*` 附属文件会被远端当成用例名。分片脚本已经这样做，并会清掉以前留下的。
- 真模型凭据 `~/.sideagent/providers.local.json` 由分片脚本自动同步（ssh 直推；Devin 沙箱经阿里云 scp 拉取），内容不经过命令行。只下发 api_key 类套餐（minimax-cn、opencode-go、zai-coding-cn）。openai-codex、kimi-coding 这类 OAuth 订阅的刷新令牌用一次就轮换，外发会让本机掉登录，所以它们的真模型用例只在本机跑。

## 本机 shell 的坑

本机 shell 是 zsh，没有 `timeout` 命令（用 `perl -e 'alarm shift; exec @ARGV' 15 <命令>`），`echo ====` 这种以等号开头的参数会报错。
