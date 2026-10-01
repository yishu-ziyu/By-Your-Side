# 任务: 侧栏里生成的文件能直接在浏览器新标签页打开查看

[当前状态](../STATUS.md)

## 起因（10-02 真人试用）

M3.1 生成了「isola-phd-ai-论证链条.html」，侧栏文件卡片只有「下载」，用户要先下载再找文件打开。用户要求：生成的文件应该允许直接打开，在浏览器中查看。

## 安全前提（主代理定）

模型生成的网页可能带脚本。以扩展身份打开会让脚本拿到扩展权限（凭据、记忆、标签页）。打开时放进隔离查看页：内容在沙箱 iframe 里（允许脚本、不同源），碰不到扩展存储与 `chrome.*` 接口。

## 完成标准

- [x] 1. 文件卡片在「下载」旁有「打开」；点了在新标签页显示文件：HTML 按网页渲染（脚本可运行）、Markdown 渲染成排版后的正文、图片与 PDF 直接显示、纯文本/CSV/JSON 原样等宽显示 — 谁检查: 机器，真侧栏
- [x] 2. 生成的 HTML 在查看页里读不到扩展存储、调不到 `chrome.*`、拿不到扩展页面的 DOM；尝试读取时失败且不影响查看 — 谁检查: 机器（构造带此类脚本的文件）
- [x] 3. 查看页标题是文件名，有「下载」按钮；文件已被删除时提示「文件已不在了」 — 谁检查: 机器
- [ ] 4. 日常扩展里点开那份论证链条 HTML，能直接看 — 谁检查: 人

## 边界与不做

- 不做在线编辑；不做跨设备分享链接。

## 实测证据

入口：`npx tsx scripts/acceptance/real-path/artifact-open.mts --headless`（只装扩展的无头 Chrome、真侧栏、本机脚本模型经设置页「自定义地址」接入，产品自己的 `artifacts` 工具写出 6 个文件：带越权探针的网页、Markdown、CSV、JSON、SVG、纯 ASCII 的 PDF）。10-02 末轮 PASS，产物 `out/acceptance/real-path/2026-10-01T18-53-20-675Z-artifact-open/`（`summary.json` 与截图）。

- 标准 1：6 张卡片都有可点的「打开」（`panel-cards.png`）；每张各开一个新标签页。网页显示标题且内联脚本把「脚本没跑」改成「脚本已运行」（`viewer-html.png`）；Markdown 出 h1「周报摘要」、加粗、2 个列表项，正文里没有 `#`/`**`（`viewer-md.png`）；SVG 解码出 120×80（`viewer-svg.png`）；PDF 是 `application/pdf` 的 blob，Chrome PDF 查看器显示「Hello PDF」（`viewer-pdf.png`）；CSV、JSON 逐字等于生成内容且为等宽字体（`viewer-csv.png`、`viewer-json.png`）。
- 标准 2：网页放在 `sandbox="allow-scripts allow-forms allow-popups allow-modals"`（无 `allow-same-origin`）的 iframe 里，加载 manifest 沙箱页 `artifact-sandbox.html`。页内脚本 8 个探针：`chrome.storage.local.get`、`chrome.runtime.id`、`chrome.runtime.sendMessage` 均因 `chrome.*` 不存在而失败；`parent.document`、写 `top.document`、`top.location` 导航、`localStorage` 均报 SecurityError；查看页标题、地址不变，DOM 里没有写入的内容。对照组：同样的读法在查看页本身（扩展来源）能读到预先放的 storage 暗号、localStorage 暗号和 `chrome.runtime.id`，证明探针能发现泄漏。另记：CDN 上的 dayjs 加载成功、无 CSP 拦截记录，说明 manifest 里放宽的沙箱 CSP 生效。
- 标准 3：6 个查看页标题都是文件名并显示「下载」；查看页「下载」得到的 notes.md 与生成内容一致、prices.csv 为 BOM+原文。对话里删除 notes.md 后，已开的查看页即时变成「文件已不在了」且隐藏「下载」（`viewer-md-deleted.png`），重新载入仍是；不存在的 id 也提示（`viewer-missing.png`）；侧栏已删除卡片的两个按钮都禁用（`panel-after-delete.png`）。
- 旧代码对照：HEAD 的卡片只有「下载」（源码里没有「打开」按钮），用例第一条判据 `openButton` 必然失败；没有在旧代码上实跑（临时副本构建时工作区依赖指回当前仓库，构建失败），只做了源码核对。

测量修正（保留原记录）：首轮（`out/acceptance/real-path/2026-10-01T18-49-28-870Z-artifact-open`）多放了一个探针「用 `fetch` 读扩展安装包里的 `/manifest.json`」，读到了，判为泄漏。随后在沙箱 CSP 加 `connect-src`（不含扩展来源）复跑（`…T18-50-23-315Z…`），仍读到：Chrome 对 `chrome-extension://` 资源不套页面 CSP，manifest 沙箱页总能读本扩展的打包文件。这些是公开代码，不含凭据、记忆或存储，不在标准 2 的范围内，所以已撤回 `connect-src`，这个探针改为只作证据、不判失败；标准 2 列出的四类都照原样判。

未验证：标准 4（日常扩展里打开那份真实的论证链条 HTML）需要人来看；查看页的样式只按截图核对过，没有和设计对照。
