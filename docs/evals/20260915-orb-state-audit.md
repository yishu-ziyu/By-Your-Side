# 最左侧点阵光球：真实运行状态检查

用户只授权检查，本轮未修改产品代码。

## 结论

1. 生产任务运行时，该光球未启动动画。
2. 该光球没有思考、执行、等待的不同形态映射。引擎支持多形态，但这个实例始终创建为 solving。

## 实测证据

沿生产面板文本入口发起本地双方案阅读任务，采集主运行块 `.run-steps > summary .run-icon canvas`，对应用户指明的最左侧光球。面板在后台标签页中运行，没有把浏览器拉到前台。

采集 82 个有光球的运行样本，画布图像只有 1 种；文案经历思考、安排助手、打开页面、读取、等待等变化。所有样本的 prefers-reduced-motion 为 false，光球没有 orb-live 类。原始画布数据见 [samples.json](20260915-orb-state-audit/samples.json)，汇总见 [summary.json](20260915-orb-state-audit/summary.json)，[等待中界面](20260915-orb-state-audit/waiting.png)。这是运行态连续画布采样，不是根据单张截图推断。

后台页面可能影响动画调度，但本次还有独立代码证据：实例根本没有调用 setRunning(true)，并非仅靠帧相同判断。没有强制修改任何媒体查询或动画参数来制造结果。

取证足够后，通过原任务的停止按钮主动停止；不把这次方案比较记为成功交付。不改动用户其他任务。

## 因果定位

- extension/src/background/index.ts:572 recordAndBroadcastHistory 将实时事件也广播成 history 信封。
- extension/src/sidepanel/main.ts:2901 applyHistory 无条件置 applyingHistory=true，逐条执行事件。
- extension/src/sidepanel/main.ts:1866 主运行球 createOrb("solving")，仅在 !applyingHistory 时启动。
- 代码没有在本轮实时事件离开 applyHistory 后补启动当前光球。
- extension/src/sidepanel/orb.ts 的 OrbHandle 只有 setRunning/dispose，没有切换 preset/state 的方法；composing/connecting 只供其他位置的光球创建时使用。
- main.ts 的接管、完成逻辑调用 setRunning(false)，但没有为等待、失败提供独立形态；也没有完整的七状态表现。

## 修复方向（未实施）

先区分历史恢复与实时事件，恢复真实运行球的动画；再把主球接入真实状态映射。完成与主动停止必须停止；回放已完成任务不能重新转动；减少动态偏好仍应生效。不同状态的动效设计需另行落实，不能以恢复一种旋转宣称全部状态已完成。
