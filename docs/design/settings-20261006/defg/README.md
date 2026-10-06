# D / E / F / G：照开源项目源码做的四版

打开 [bys-settings-refs.html](bys-settings-refs.html)。顶部切换 D/E/F/G。`?v=F` 直达某一版，`?nopicker` 隐藏切换条，`?reduce` 强制减少动效。

数据是 BYS 真实的服务商列表（`providerChoices()`，36 项含自定义）和真实表单文案。样式是 BYS 的 `styles.css` 和 `settings.css` 原文件，再加 [src/proto.css](src/proto.css)。原型不联网，不保存 key。

## 四版

| 版本 | 结构 | 参考 |
| --- | --- | --- |
| **D Raycast 分组（推荐）** | 按接入方式分 4 组：默认模型（主模型 + 快速模型）/ 账号登录 / API key / 自定义地址 | Raycast Settings → AI（闭源，照官方手册截图） |
| E Zed 一页平铺 | 每家一段。没填 = 输入框，回车保存；已填 = 一行 ✓ | Zed `llm_providers_page.rs`、`configured_api_card.rs` |
| F Chatbox 只列在用的（备选） | 只列已连接的 6 家，「+ 添加服务商」打开 Spotlight 搜索 | Chatbox `ProviderList.tsx`、`ProviderSpotlight.tsx` |
| G Cline 细线列表 | 无卡片，细线分隔，顶上写「36 家可用 · 6 家已连接」，每行写模型数 | Cline `provider-list-view.tsx` |

commit 和完整路径见 [../refs/README.md](../refs/README.md)。

## 截图和录屏

- D：[默认](shots/D-1-default.png) · [添加菜单](shots/D-2-addmenu.png) · [验证后保存](shots/D-3-verified.png) · [主模型菜单](shots/D-4-modelmenu.png) · [录屏](videos/D.mp4)
- E：[默认](shots/E-1-default.png) · [输入 key](shots/E-2-typing.png) · [保存后](shots/E-3-saved.png) · [录屏](videos/E.mp4)
- F：[默认](shots/F-1-default.png) · [Spotlight](shots/F-2-spotlight.png) · [Spotlight 搜索](shots/F-2b-search.png) · [详情页](shots/F-3-detail.png) · [录屏](videos/F.mp4)
- G：[默认](shots/G-1-default.png) · [搜索](shots/G-2-search.png) · [详情页](shots/G-3-detail.png) · [录屏](videos/G.mp4)
- 切换条：[窄](shots/picker-narrow.png) · [宽](shots/picker-wide.png)

## 源码

- [src/data.js](src/data.js)：服务商数据（同 `providerChoices()`）和内联图标。
- [src/common.js](src/common.js)：状态、元素工厂、详情表单。[src/detail.js](src/detail.js)：F/G 共用的详情页。
- [src/variant-d.js](src/variant-d.js) · [src/variant-e.js](src/variant-e.js) · [src/variant-f.js](src/variant-f.js) · [src/variant-g.js](src/variant-g.js)
- [icons/](icons/)：品牌图标，来自 `@lobehub/icons-static-svg` 1.95.1（MIT）。进产品前要确认是否用、怎么注明来源。

## 重建

```sh
git show a0169d8:extension/src/sidepanel/styles.css > src/bys-styles.css
git show a0169d8:extension/src/settings/settings.css > src/bys-settings.css
git show a0169d8:extension/icons/brand-mark.svg > src/brand-mark.svg
python3 build.py   # 默认用 npx esbuild@0.28.2；可用 ESBUILD=路径 指定
```

重建出的 `bys-settings-refs.html` 与这里提交的逐字相同（已核对）。`shoot.py`、`record.py` 写的是作者机器上的绝对路径，用前要改。
