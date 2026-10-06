# 侧栏高保真原型：用户选定版（2026-10-06）

这是设计参考，不是产品代码。实现交接写在 [#58 的交接评论](https://github.com/yishu-ziyu/By-Your-Side/issues/58#issuecomment-6011562876)。

## 用户的选择

| 面 | 选择 | 一句话 |
| --- | --- | --- |
| 顶栏 | B | 任务名 + 新会话、记忆两枚灰图标 + ⋯，常驻 |
| 上下文 chip | C | chip 跟在用户自己那条消息下面，右对齐 |
| 过程行 | A | 一行灰字「做了 3 件事 ›」，点开是步骤列表 |
| 记忆展开 | A | 弹簧撑开高度（motion/mini），减少动效时直接显示 |

记忆引用的形态沿用 #56：折起 = D（句尾灰字「用了 N 条记忆 ›」），展开 = X1（Dia 密度的小条）。

## 打开

- 双击 `bys-proto.html`。地址后面加 `?topbar=B&chips=C&process=A&memory=A&nopicker` 就是选定版。
- 左下角的变体选择器只在原型里有，不进产品。
- 原型不发任何东西：「我来发送」只把 Gmail 的发送键圈出来。

## 文件

- [bys-proto.html](bys-proto.html)：单文件，可直接打开。
- [src/proto.css](src/proto.css)：原型补的样式。产品 token 一律没改。
- [src/main.ts](src/main.ts)：原型交互。用到 `@floating-ui/dom`、`remend`、`motion/mini`、`@formkit/auto-animate`。
- [src/current.ts](src/current.ts)、[src/current-template.html](src/current-template.html)：「现状」对照页。
- [build.mjs](build.mjs)、[package.json](package.json)：重建用。
- [shots/](shots/)：验收截图。[videos/](videos/)：流式、chip、菜单三段录屏。

## 重建

原型基于 main `f0578b4`。下面三个文件与当时的仓库逐字相同，这里不重复存放，重建前取出：

```sh
git show f0578b4:extension/src/sidepanel/styles.css > src/styles.css
mkdir -p src/vendor
git show f0578b4:extension/src/sidepanel/stream-reveal.ts > src/vendor/stream-reveal.ts
git show f0578b4:extension/src/shared/markdown.ts > src/vendor/markdown.ts
npm install && node build.mjs
```

## 与 main 的差别

原型做完后 main 又前进了两次（`e87d6be` 输入框只留一行工具，`6b5f427` 建议只填草稿、链接前用站点真图标）。原型里输入框的 `···`、「继续」，以及句内链接的 lucide 小图标，都以 main 为准，不要照搬回去。
