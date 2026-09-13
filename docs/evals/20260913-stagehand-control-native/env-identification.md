# 任务: 识别用户真正使用 By Your Side 的 Chrome 实例（阶段 1）

范围：只做识别与环境取证，不重载扩展、不改用户设置、不动业务页面；供主代理决定真实面板验收的下一步。

## 完成标准

- [x] 列出目标 app / 窗口 / 进程 / user-data-dir / 调试端口归属，并给出可复用连接信息 — 检查者: 本文件命令输出
- [x] 判定扩展注册路径与 native host 运行位置 — 检查者: Secure Preferences 与 host manifest 实读
- [x] 明确“当前是否有运行中的 By Your Side 实例”，无证据处标注未验证 — 检查者: 9222 target 列表对照
- [ ] 真实面板验收（待主代理确认代码检查通过、并决定实例与 native host 处理方式后执行）

## 边界与不做

- 不重启任何浏览器、不改变默认浏览器、不给旧 ChromeMain 额外装扩展、不读凭据。
- 不重载扩展；真实麦克风未跑，不计入任何通过项。

## 方法（全部只读）

- Codex CU：`cua.getState()`、`cua.getApp("com.google.Chrome")` 读 app/窗口 AX。
- `lsof` 读监听端口与进程 open files；`curl http://127.0.0.1:9222/json/version|/json/list` 读 target。
- 读 `~/Library/Application Support/Google/*/{Local State,Default/{Preferences,Secure Preferences}}`、
  `*/NativeMessagingHosts/com.sideagent.host.json`、`~/.sideagent/native-host.sh`、`~/.sideagent/wrapper-err.log`。
- 注：沙箱禁止 `ps`/`pgrep`，进程信息一律来自 `lsof`。

## 实测事实（2026-09-13 约 19:35–19:40 本地时间）

1. 运行中的 Chrome 主进程只有三个：PID 3541（ChromeMain）、PID 58906（Chrome-headless）、PID 65947（Chrome for Testing）。
2. PID 3541：`txt=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，open files 全在
   `~/Library/Application Support/Google/ChromeMain/`；`SingletonLock -> yishu.local-3541`；`lsof` 证实它持有
   `127.0.0.1:9222`（LISTEN）。即 **9222 = ChromeMain 实例**，与主代理结论一致。
3. Codex CU 里 app `com.google.Chrome` 的窗口（`Deep Agents - Stagehand`，含用户日常标签与
   “只回复：整理验收通过。不操作网页。”等分组）与 9222 `/json/list` 的 page 列表逐条对应
   （chatgpt.com 会话、X 首页、BOSS 直聘、阿里云登录页 ×2、B站 BV1ZytW6qETd、flomo、女娲 Nuwax、
   Particle Scroll、Beautiful UI、How I manage my agents、VibeHub…）。因此 CU 当前唯一可见的
   Google Chrome 窗口就是 PID 3541 这个 ChromeMain profile 实例。
4. 该窗口工具栏无 By Your Side 图标（仅有 Global Speed / ChatGPT Sidebar / Video Download Helper /
   Stylus / Save to my mind / Read Frog），9222 `/json/list` 全量 target 中**没有**
   `chrome-extension://fnbjglhppbkgmjeehablkfilmmefjolo/*` → 该实例当前没有运行 By Your Side。
5. 用户默认 profile `~/Library/Application Support/Google/Chrome` **未在运行**：无 `SingletonLock`、
   无 `DevToolsActivePort`，`lsof` 全量无进程占用。native-saved.txt（今天 15:37）里的 By Your Side
   实例既不是默认 profile，也不是当前运行中的实例。
6. Chrome for Testing PID 65947：`SingletonLock -> yishu.local-65947`（19:31 启动），
   `user-data-dir=…/Google/Chrome for Testing`，无 `DevToolsActivePort`，profile 内无本扩展存储。
   另有 PID 58906 用 `…/Google/Chrome-headless`（harness 产物）。
7. 扩展注册（ChromeMain `Default/Secure Preferences`，mtime 2026-09-13T11:37:09Z）
   `fnbjglhppbkgmjeehablkfilmmefjolo`：`location=4`（unpacked），
   `path=/Users/mahaoxuan/Desktop/ego/extension/dist`。该目录**已不存在**；
   当前仓库 `AI 产品/By-Your-Side/extension/dist` 于 19:31:54 重建。
   默认 profile 的 `Secure Preferences` 中该扩展 **absent**。
8. native host：`com.sideagent.host.json` 同时装在 `Google/Chrome` 与 `Google/ChromeMain` 的
   `NativeMessagingHosts`，path 均为 `~/.sideagent/native-host.sh`；该脚本
   `exec <node> <repo>/node_modules/tsx/dist/cli.mjs <repo>/agent/src/main.ts`，其中 repo 仍是
   `/Users/mahaoxuan/Desktop/ego`（不存在）。即装的 host 指向搬迁前路径。
9. 仍存活 16:02 起的孤儿 host 进程：node PID 1275（cwd `~/.sideagent`，含 tsx/esbuild 子进程）；
   `wrapper-err.log` 最后写入 16:02，末两行为“SideAgent 伴随进程已启动（native messaging 模式）…
   面板已连接（native messaging）”，此后无日志。ChromeMain `DevToolsActivePort` mtime 亦为 16:02。

## 结论与阻塞

- 当前**不存在**已加载本仓库最新 `extension/dist` 且面板可用的运行实例；CU 可操作目标只有
  `com.google.Chrome`（PID 3541，ChromeMain profile，无调试端口，只能 AX/UI）。
- 两个授权外的前置问题需要主代理裁决：
  1. By Your Side 在 ChromeMain 的注册路径指向已删除的旧仓库目录，重载会直接失败；
     是否重装 host / 重指路径（`npm run install:host` 会写用户设置）不在本任务授权内。
  2. 若要真实面板验收，需要决定在哪个实例加载/重载当前 `extension/dist`（只允许重载这一个扩展）。
- 未验证：ChromeMain 里那条 unpacked 注册记录当前是“未加载”“被禁用”还是“加载报错”。
  9222 无扩展 target 只能证明它没有在跑；要区分需看扩展页，涉及操作用户窗口，等主代理指示。
- 真实麦克风未跑。
