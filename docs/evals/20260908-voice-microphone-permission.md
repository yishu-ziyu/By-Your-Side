# 任务：首次使用语音时能开启麦克风授权，失败后有可用的恢复入口

## 完成标准
- [ ] 侧栏拒绝/无法弹出授权时，显示“开启麦克风”，点击打开本扩展独立授权页；不反复在侧栏请求同一个失败权限。— 机器与浏览器
- [x] 授权页仅在用户点击按钮后请求 audio，不请求 video，不连接 Step，不保存录音；拿到流后立即停止所有轨道。— 单测与源码检查
- [ ] 授权成功后回侧栏点击重试，可进入语音连接；授权失败给出 Chrome / macOS 恢复指引，不虚报授权成功。— 浏览器与人
- [x] typecheck、相关测试、build、diff --check 通过。— 机器

## 复现
- 用户截图：NotAllowedError 对应的“未获得麦克风权限”错误。
- ChromeMain 生产 sidepanel 实时读取：permission=prompt，isSecureContext=true，错误提示仍在。用户未授权与明确拒绝不能混为一谈。
- Chromium Extensions 讨论确认侧栏弹窗受限，建议普通扩展页 getUserMedia 后立即关闭流：https://groups.google.com/a/chromium.org/g/chromium-extensions/c/V09VMCLzvWM/m/N322oyRGAAAJ

## 边界
- 不自动修改 Chrome 或系统权限；浏览器授权由用户选择。
- 不改变已确认的粒子球布局，不自动开始监听。


## 修复与验证
- 新增 voice-permission.html + voice-permission-page.ts，普通扩展标签页手动请求，拿到流立即停止。
- VoiceClient 标记 NotAllowedError，UI 提供“开启麦克风”，授权已 granted 时重试直接回原语音启动路径；回到侧栏聚焦时更新授权提示。
- 8 项相关测试、typecheck、build、git diff --check 通过。ChromeMain 中 reload:ext 成功，新包已生效。
- CUA 无法定位 ChromeMain 侧栏，wrapper 原生 AX 读取超时；未用默认浏览器替代。授权页到侧栏真实麦克风路径仍需用户点击允许后验证，未标为完成。
