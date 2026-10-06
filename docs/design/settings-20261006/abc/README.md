# A / B / C：照 BYS 现有源码做的三版

打开 [bys-settings-proto.html](bys-settings-proto.html)。地址后面加 `?v=A`、`?v=B` 或 `?v=C` 选版本，加 `?nopicker` 隐藏右上角的挑选面板。

CSP 是 `connect-src 'none'`：不发请求，不写存储。设备码登录和测试连接都是本地模拟。

## 三版

| 版本 | 结构 | 借的开源源码 |
| --- | --- | --- |
| **A 安静列表（推荐）** | 当前模型一行 → 一张列表：搜索、已连接、其余折起 → 点一行就地展开详情 | Cherry Studio `ProviderList.tsx`（搜索同时匹配模型名，按启用分区）；Zed `llm_providers_page.rs`（已配置的 key 只显示一行状态 + 动作） |
| B 左右两栏 | 248px 左栏列服务商，右栏是详情；页面宽 860px | Cherry Studio `ProviderList.tsx`、`ProviderListItem.tsx`、`classNames.ts`、`ProviderListGroup.tsx` |
| C ⌘K 命令面板 | 只显示当前模型。点「换一个」或按 ⌘K 弹出一个能搜模型和服务商的面板 | Zed `language_model_selector.rs`；Open WebUI `ModelSelector/Selector.svelte` |

commit 和完整路径见 [../refs/README.md](../refs/README.md)。

## 截图和录屏

- 默认态：[A](shots/A-default.png) · [B](shots/B-default.png) · [C](shots/C-default.png)
- 交互态：[A 搜 glm 就地展开](shots/A-search-open.png) · [B 搜 kimi 右栏详情](shots/B-search-detail.png) · [C ⌘K 搜 kimi](shots/C-palette.png)
- 整页：[A](shots/A-fullpage.png) · [B](shots/B-fullpage.png) · [C](shots/C-fullpage.png)
- 现状对照：[A](shots/compare-current-vs-A.png) · [B](shots/compare-current-vs-B.png) · [C](shots/compare-current-vs-C.png)
- 拼页：[默认](shots/pages/page1-default.png) · [交互](shots/pages/page2-interaction.png)
- 录屏：[A](videos/A-flow.mp4) · [B](videos/B-flow.mp4) · [C](videos/C-flow.mp4)

## 源码

- [src/data.ts](src/data.ts)：状态和服务商分组（同一家的不同地区合成一行）。
- [data/choices.json](data/choices.json)：由 main `a0169d8` 的 `createModelRuntime().providerChoices()` 直接导出（pi-ai 0.84.4），不是手写的。
- [src/common.ts](src/common.ts)：元素工厂、头像、状态文字、详情表单、可搜索的模型下拉（`@floating-ui/dom`）。
- [src/variant-a.ts](src/variant-a.ts) · [src/variant-b.ts](src/variant-b.ts) · [src/variant-c.ts](src/variant-c.ts)：三版。
- [src/lower.ts](src/lower.ts)：快速模型、实时语音、开关这些下半页。
- [src/proto.css](src/proto.css)：原型样式，只用 token 里已有的变量。

## 重建

```sh
git show a0169d8:extension/src/sidepanel/styles.css | sed -n 1,184p > src/tokens.css
git show a0169d8:extension/icons/brand-mark.svg > src/brand-mark.svg
npm install && node build.mjs
```

重建出的 `bys-settings-proto.html` 与这里提交的逐字相同（已核对）。`shoot.py`、`record.py`、`pages.py` 是截图和录屏脚本，里面写的是作者机器上的绝对路径，用前要改。
