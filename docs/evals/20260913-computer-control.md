# 原生电脑控制排查与复测

用户要求先解决电脑控制问题，再试用 By Your Side；不得改用 CDP、Playwright、AppleScript 等替代 UI 操作。

## 实测

- 原生 CUA 服务已运行，插件已注册；本地 helper codesign 校验通过。macOS 15.5，桌面客户端 26.908.40834。
- 原生计算器：点击清除、键盘输入 17×23，AX 与截图均为 391。
- Chrome 原生窗口：连接 com.google.Chrome，Raise 后新建标签页，输入 chrome://version，AX 与截图一致。实际 profile 为 ChromeMain/Default。
- Chrome 扩展搜索：原生键盘输入 By Your Side，AX 与[截图](20260913-computer-control/chrome-extension-search.png)一致，均为未找到任何搜索结果。
- 期间一个 Return 未完成导航，读到地址栏仍在编辑后补一次 Return 完成。没有把单次工具调用成功当成动作完成。

## 原问题与处理

local.yishu.chrome-main 是 ~/Applications/Chrome.app 的启动脚本，其自身没有 Chrome 窗口。之前以它作为操作对象反复超时属定位错误，改为实际窗口所属 com.google.Chrome。

cua.getState/listTabs 的浏览器连接仍出现过超时；本轮改用同一原生电脑控制 API 的 getApp，未使用其他控制技术。AX 点击或 setValue 的效果需以新状态确认；原生按键在本次复测可完成输入。之前出现的截图与文字不同步，本次经窗口定位、Raise及逐步读回后未再出现，但不能断言已修复所有后台截图问题。

未重装客户端、未重启系统或改系统权限、未编辑授权白名单、未改产品源码。此次解决了操作目标与调用方式，验证原生电脑控制可以工作，不宣称修复第三方闭源服务。

## 后续

By Your Side 尚未实际试用。当前 ChromeMain 找不到该扩展；本地待加载产物为 extension/dist，manifest 名称 By Your Side 0.1.0。加载会授予 <all_urls>、debugger、nativeMessaging 等能力，需要明确确认后再安装到日常浏览器。

官方说明：https://learn.chatgpt.com/docs/computer-use 。OS 的 Screen Recording / Accessibility 和应用授权是分开的；浏览器连接仅提供额外能力，不是原生应用控制的先决条件。

## 后续实测修订

用户随后自行加载了扩展。侧栏试用再次出现 noWindowsAvailable/点击无即时响应，不能维持“整体电脑控制已稳定”的判断。本轮核实进程身份后重启一次原生 helper，继续用原生 setValue、按钮、窗口菜单与Finder激活完成多条真实任务；未换控制技术。详见 [实际试用](20260913-native-dogfood.md)。
