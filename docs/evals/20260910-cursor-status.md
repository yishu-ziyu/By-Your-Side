# 任务: 任务执行时，用户从光标上直接看懂"在等 / 在读 / 完成 / 失败"，它在别的标签页干活时能一键跟过去

2026-09-10 第二轮光标可视化。第一轮（尺寸、动作名牌、目标边框）已由用户看录屏确认可用，本轮做状态层。
用户已确认样态（`docs/previews/cursor-status-round2.html`）：状态跟光标、字号"再小一点"、跨页在右上角可点、完成停 1 秒后自动收、失败留在原地。
实现：页面侧 `extension/src/content/cursor.ts`（文案、配色、计时、胶囊都在页面侧）+ background 侧 `extension/src/background/cursor-status.ts`（决定状态、目标标签页、生命周期）。

## 完成标准

- [x] 1. 等待：任务开始、还没轮到页面动作时，光标旁显示"正在等模型响应"和已等秒数；模型开始动手或本轮结束时收起。— 谁检查: 定点测试 + 隔离浏览器
- [x] 2. 读页面：读取类工具（`snapshot` / `read_element` / `screenshot` / `observe_page`）执行期间显示"正在读这个页面"；工具结束收起，回到等待或完成。— 谁检查: 定点测试 + 隔离浏览器
- [x] 3. 完成：一轮正常结束时显示"完成"，约 1.5 秒后自动消失，光标回角落。— 谁检查: 定点测试 + 隔离浏览器
- [x] 4. 失败：一轮以错误结束时，光标停在出错位置显示"这一步没做成"并保持，直到下一轮开始或用户接管。— 谁检查: 定点测试 + 隔离浏览器
- [x] 5. 跨页：它在另一个标签页操作、而你看的是当前页时，当前页右上角出现可点胶囊"正在另一个标签页工作 · 标题"；点击切到那个标签页；操作结束胶囊消失。— 谁检查: 隔离浏览器（切页由人裁）
- [x] 6. 不干扰既有行为：动作名牌、危险确认双键、接管横幅、标注互不打架；接管时状态隐藏。— 谁检查: 定点测试 + 隔离浏览器（真实页观感待人裁）
- [x] 7. 字号按用户选择"再小一点"（主文案 11px / 名字 9.5px / 内边距 4px 8px），浅色与深色页面上均可辨认。— 谁检查: 机器出图 + 人判断
- [x] 8. 全量测试、typecheck、build 通过；正式扩展重载后运行代码与构建一致。— 谁检查: npm test、npm run typecheck、npm run build、SHA 核对
- [ ] 9. 用户在真实网页上确认：不挡内容、能看懂、跨页跳转符合预期。— 谁检查: 人

## 边界与不做

- 不改语音断句、模型路由、任务权限与执行成功定义。
- 状态不加持续动画、不加声音；减少动态效果下只做静态显示。
- 不做多成员并行的多套状态条；沿用现有成员色光标与名字。
- 不做"等待人工确认"的状态条；接管继续用现有横幅。

## 证据

代码：`extension/src/content/cursor.ts`（状态层、右上角胶囊、字号）、`extension/src/background/cursor-status.ts`（新增）、
`extension/src/background/index.ts`（事件映射、点胶囊切页、接管/停止抑制）、`extension/src/sideagent.d.ts`。

机器证据（2026-09-10 21:16 全量复跑，均绿）：

| 层 | 入口 | 结果 |
| --- | --- | --- |
| 定点单测 | `extension/test/cursor-status.test.ts` | 14 项通过（等待/读/完成/失败映射、跨页胶囊、切回收起、接管抑制、idle 只清暂时状态、执行键隔离、页面被关） |
| 隔离浏览器 | `node extension/test/cursor-status-check.mjs` | PASS：文案、11px/9.5px 字号、状态色条（#f59e0b/#2f6fed/#16a34a/#e2554f）、秒数走字、完成 1.5 秒自动收+回角落、失败保持并停原地、胶囊贴右上角且点击发 `cross_page_click`、拿住双键不被状态覆盖、深色页与减少动态下可见 |
| 回归 | `node extension/test/overlay-check.mjs` | PASS（第一轮光标、mark、滚动跟随未受影响） |
| 全量 | `npm test` / `npm run typecheck` / `npm run build` | 136 文件 1117 项通过；两个 workspace 类型检查通过；构建通过 |
| 部署一致 | `shasum` + CDP 取运行中扩展文件 | `background.js` `1af859c43121…`、`content-cursor.js` `42472201d7c6…`、`manifest.json` `af72488f2791…` 与构建逐字节一致；扩展已重载 |

截图（`docs/evals/20260910-cursor-status/`）：`1-waiting-light.png`、`2-done.png`、`3-failed.png`、
`4-cross-page.png`、`5-hold-vs-status.png`、`6-dark-reduced.png`；原始日志 `isolated-browser.log`、`unit.log`、`overlay-round1.log`、`build.sha256`。

已知取舍（写进实现，供人判断）：非读取类工具执行期间（如 navigate/scroll）沿用"正在等模型响应"，不新增未批准的第六种文案；
用户主动停止后短暂出现的"完成"由 `suppressCursorStatus` 收尾，任务真正失败以 `error` 事件为准。

待用户判断：标准 9（真实网页上的可辨认度、是否挡内容、点胶囊跳转手感），以及"等待秒数从本次状态开始重新计时"是否符合直觉。
