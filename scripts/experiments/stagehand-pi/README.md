# Stagehand + Pi 可行性探针（实验，非生产）

目的：在**隔离**环境里验证 By-Your-Side 依赖的契约是否成立，而不是把 Stagehand 接进生产。
对齐证据：`browserbase/stagehand` @ `b771930d2b4d858e5bd9670203c66260b385a8fa`，SDK `4.1.0`。

1. `connect` 是否必须已有 CDP 端点（能否附着普通 Chrome）。
2. `fill` 只改指定字段，不提交表单（本地无提交表单）。
3. 切换活跃页面后，**原有页面句柄**仍绑定原页（句柄层证据；AI `act()` 的默认页未跑）。
4. 批次 `deadline` 截止后不再新增写入。**deadline 不是用户 abort**：4.1.0 的 Page/Locator
   动作没有 `AbortSignal` 参数，用户级取消在本探针中未跑。
   本项必须先确认截止前的前置写入真实发生（`lastName`），否则记 `INCONCLUSIVE`，不记 PASS；
   `experimentalBatch` 必须显式传 `{ page: target, timeout }`，否则批次默认打在活跃页上。

## 边界

- 只 launch 无头隔离 Chromium + 本地 fixture；**没有 connect 运行路径**，不连接、不启动用户的
  日常 Chrome，不读用户 profile，不会 goto 既有页面或关闭既有浏览器。
- 脚本拒绝任何 GUI/计算机操作参数（`--computer-use`、`--gui`、`--headful`、`--window-position`、`--user-data-dir`）。
- 只有检测到真实 `@browserbasehq/stagehand` 才会执行契约测试；缺失即报 `BLOCKED`，不使用自写 CDP/Playwright 包装冒充 Stagehand。
- 只写本目录与 `out/`；不改生产代码、根依赖或 lock。

## 运行

```sh
cd scripts/experiments/stagehand-pi
# Node >=22.18.0；可在本目录 npm install --workspaces=false 安装固定 SDK。
# 默认读取本目录 node_modules，也可指向独立安装目录：
STAGEHAND_MODULE_ROOT=/path/to/node_modules npm run probe:env   # 只做环境能力检查
STAGEHAND_MODULE_ROOT=/path/to/node_modules npm run probe       # 完整探针，结果写入 out/result.json
```

退出码：`0` `probeStatus=passed`；`1` `failed`；`2` `blocked`；`3` `inconclusive`。`INFO` 是源码/范围说明，不计入成败。

`out/result.json` 同时写两个状态，互不掩盖：

- `probeStatus`：只描述探针自身。
- `acceptanceStatus`：原始用户契约（中途停止不新增操作、纠正姓名保留其他字段、真人语音、日常 Chrome）。
  本轮固定 `blocked`——探针的 deadline 不等于用户 abort，不得因 `probeStatus=passed` 宣称用户契约通过。

环境能力检查和契约测试是两层证据，分开记录：若无法建监听/连接（CDP 依赖 localhost socket），
浏览器层契约就是 `BLOCKED`，不能记为通过或失败；环境受阻时其余检查不运行。
