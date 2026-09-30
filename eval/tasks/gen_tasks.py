import json
S={
'CL':'Claude in Chrome 官方示例（https://claude.com/claude-for-chrome）',
'CLS':'Claude in Chrome 帮助中心：快捷指令/录制工作流/定时任务（https://support.claude.com/en/articles/12012173）',
'AT':'ChatGPT Atlas 少数派评测：分析热榜/汇总评论（https://sspai.com/post/103275）',
'ATM':'ChatGPT Atlas MakeUseOf 评测：复制表格数据被写成摘要',
'ATT':'ChatGPT Atlas 标签页命令/光标聊天（https://sspai.com/post/103275）',
'CO':'Perplexity Comet：@tabs 总结与比较标签页（Reddit r/perplexity_ai）',
'COS':'Perplexity Comet：/ 自定义快捷指令（Reddit r/perplexity_ai/comments/1mo96zy）',
'GE':'Gemini in Chrome 帮助页示例：总结/换种解释/出题/改菜谱（https://support.google.com/chrome/answer/16283624）',
'GEC':'Gemini in Chrome：多标签比较（最多 10 个标签）（https://support.google.com/chrome/answer/16283624）',
'GEA':'Gemini auto browse：比价、找信息、提交前确认（https://support.google.com/chrome/answer/16821166）',
'ED':'Edge Copilot Mode：多标签比较/菜谱转换/侧窗翻译（blogs.windows.com/msedgedev 2025-07-28）',
'EDV':'Edge Copilot Mode：语音导航（blogs.windows.com/msedgedev 2025-07-28）',
'NE':'Opera Neon Do：打开 NASA 任务页面 demo（Opera blog 2025-09-30）',
'NEV':'Opera Neon The Verge 评测：数错文章评论数',
'NEC':'Opera Neon Cards：抽取详情+对比表（Opera blog 2025-09-30）',
'DIA':'Dia Skills：/summary /proof 等（https://www.diabrowser.com, TechCrunch 2025-07-21）',
'MO':'Monica Browser Operator：数据收集/竞品监控/表单处理（https://monica.im/help/Features/AI-Agent/Monica_Agent）',
'SI':'Sider：划词解释/整页翻译（https://sider.ai/extensions/ai-chrome-extension）',
'SIH':'Sider Hand demo：价格追踪表/活动情报表/联系方式收集（https://sider.ai/agents/claw）',
'DB':'豆包浏览器插件：逐段双语翻译/网页总结/划词技能（https://www.aigcdaily.cn/news/a24xeooj6lj21cg）',
'DBR':'豆包工作 录制回放技能（https://ai-bot.cn/doubao-browser-recording-replay-review/）',
'KI':'Kimi 浏览器扩展：自动调研成文/智能填写信息/录制 Skill（https://www.kimi.com/products/kimi-browser-extension）',
'MA':'Manus Browser Operator：用本地浏览器做调研（https://manus.im/blog/manus-browser-operator）',
'HA':'HARPA AI：{{selection}} 命令/页面监控/抽取（https://harpa.ai）',
'NA':'Nanobrowser 多 agent demo（https://github.com/nanobrowser/nanobrowser）',
'BU':'Browser Use demo：HN 前 10/GitHub trending/商品→CSV（https://browser-use.com/changelog）',
'SG':'Sitegeist 用例（https://github.com/badlogic/sitegeist；BYS docs/evals/20260925-sitegeist-parity.md）',
'V2':'V2EX 用户讨论：翻译插件替代（https://www.v2ex.com/t/1179926）',
'BYS':'By Your Side 自有功能（README/usage.md），对标 Claude/Gemini 同类能力',
}
T=[]
def t(cat,url,prompt,rule,src,hard=None,setup=None):
    d={'category':cat,'site_url':url,'prompt':prompt,'success_rule':rule,'source':S[src]}
    if hard: d['why_hard']=hard
    if setup: d['setup']=setup
    T.append(d)
BK='https://books.toscrape.com/'
QT='https://quotes.toscrape.com/'
WS='https://webscraper.io/test-sites/e-commerce/allinone/computers/laptops'
HN='https://news.ycombinator.com/front?day=2024-01-01'
RY='https://www.ruanyifeng.com/blog/2026/09/weekly-issue-413.html'
SP='https://sspai.com/post/103275'
TI='https://the-internet.herokuapp.com/'
PZ='https://httpbin.org/forms/post'
# ---------------- page_understanding
P='page_understanding'
t(P,RY,'这期周刊的封面文章讲了什么？用三句话概括作者的核心观点。','回答必须提到 Shopify 放弃 React Native 转向原生（Swift/Kotlin），并指出作者认为真实原因是省钱/AI 让跨平台翻译层失去必要性；缺任一点判失败','GE')
t(P,RY,'这期周刊“工具”栏目一共推荐了几个工具？','回答数量为 10（以测试时页面为准）','NEV','需要准确计数而非估算，Opera Neon 被评测指出会自信地数错')
t(P,SP,'这篇文章是谁写的、哪天发布的？大概要读多久？','同时给出作者 _xy、日期 2025年10月24日、阅读时长约 17 分钟，三项都对才通过','BYS')
t(P,SP,'文章里的对比表格从哪几个维度比较了这几款浏览器？','列出 6 个维度：核心哲学、核心功能、主要应用场景、用户界面、记忆模型、理想用户；缺漏或多编一个即失败','AT')
t(P,'https://www.postgresql.org/support/versioning/','PostgreSQL 现在还在维护的版本有哪些？哪个最快停止支持，具体哪天？','列出 18/17/16/15/14 五个受支持大版本，并指出 14 最先 EOL，日期为 2026-11-12（November 12, 2026）','GE')
t(P,'https://sqlite.org/limits.html','SQLite 一个连接最多能 ATTACH 多少个数据库？默认值和上限分别是多少？','回答默认 10、上限 125，两个数字都对才通过','GE')
t(P,'https://nodejs.org/en/about/previous-releases','Node.js 现在哪些版本是 LTS？各自代号是什么？','至少给出 v24 Krypton 与 v22 Jod 均为 LTS，且未把 v26 说成 LTS（以测试时页面为准）','GE')
t(P,'https://arxiv.org/abs/1706.03762','这篇论文有几位作者？最新是第几版？第一版哪天提交的？','回答 8 位作者、v7、v1 于 2017-06-12 提交，三项都对才通过','MA')
t(P,'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Array/flat','flat() 不传参数的时候默认展开几层？遇到数组空槽会怎样？','回答默认深度为 1，且说明会移除/跳过空槽','GE')
t(P,'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled','用大白话给我讲讲 Promise.allSettled 和 Promise.all 的区别，再出 3 道选择题考考我。','解释中说明 allSettled 等所有 Promise 敲定且不会因单个 reject 而短路、结果对象含 status 为 fulfilled/rejected；且给出恰好 3 道带选项的选择题','GE')
t(P,'https://www.who.int/zh/news-room/fact-sheets/detail/diabetes','这页里全球糖尿病患者人数从 1990 年到 2022 年变化了多少？','回答 1990 年约 2 亿、2022 年约 8.3 亿（或给出二者差值约 6.3 亿且标明两端数字）','GE')
t(P,'https://tc39.es/ecma262/','这份规范草案是哪一年的版本？Array.prototype.toSorted 在第几节？','回答 ECMAScript 2027，且 toSorted 章节号为 23.1.3.34（以测试时页面为准）','GE','页面约 7.6MB，超长上下文需要定位而非整页塞入')
t(P,'https://kubernetes.io/zh-cn/docs/concepts/overview/','Kubernetes 这个名字是什么意思？K8s 里的 8 是怎么来的？','回答名字源于希腊语“舵手/飞行员”，且 8 表示 K 与 s 之间有 8 个字母','GE')
t(P,'https://www.tiobe.com/tiobe-index/','这个月的编程语言排行榜前三是谁？Python 占比多少？','前三为 Python、C、C++（依测试时页面，2026-09 快照），Python 占比与页面一致（快照 17.76%）','AT')
t(P,'https://www.douban.com/','','占位','BYS') if False else None
t(P,'https://movie.douban.com/top250','这一页里评分最高的是哪部电影，多少分？有几部是 2010 年及以后上映的？','回答肖申克的救赎 9.7，且 2010 年及以后的数量为 6（以测试时页面为准）','AT','需要逐条读年份并计数')
t(P,HN,'这天 HN 首页里有几条是 Show HN？分别排第几？','回答 3 条，排名 13、14、30','NEV','计数+定位，易漏')
t(P,'https://www.gov.cn/zhengce/zuixin/','帮我看看这页最新的三条政策标题，分别是哪天发的。','给出的三条标题与日期与测试时页面列表最上方三条完全一致（动态页，人工对照）','AT')
t(P,'https://www.stats.gov.cn/sj/zxfb/','国家统计局最近一次发布的工业增加值数据是多少？','回答与测试时页面最新发布一致（2026-09-30 快照：8 月份规模以上工业增加值增长 5.2%）','AT')
# ---------------- selection_ask
P='selection_ask'
t(P,RY,'（选中“真实原因是省钱”附近那段话后按 Ctrl+J）这段话的逻辑站得住吗？有没有反例？','回答针对选中段落（Shopify/React Native 省钱论点）展开，并至少给出一个具体反例或反驳点；若回答对象变成整页其他内容则失败','SI',setup='选中封面文章中讨论“真实原因”的段落')
t(P,RY,'（选中关于格陵兰和非洲面积的句子）这个说法对吗？为什么地图上看起来差不多大？','回答确认非洲面积约为格陵兰 14 倍，并解释墨卡托投影高纬度放大','SI',setup='选中周刊中关于格陵兰/非洲面积或 Equal Earth 投影的句子')
t(P,'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Array/flat','（选中示例代码块）逐行解释这段代码的输出。','对所选示例每个 console.log 给出的输出与 MDN 页面注释一致','DB',setup='选中页面“尝试一下”或示例中的一段代码')
t(P,'https://docs.python.org/zh-cn/3/library/itertools.html','（选中 batched 的说明）这个函数是哪个版本加的？给我一个把列表每 3 个分一组的例子。','回答 3.12 加入，且示例代码使用 batched(...,3) 并给出正确分组结果（如 ABCDEFG→ABC DEF G）','HA',setup='选中 itertools.batched 条目')
t(P,SP,'（选中文章里一个你不懂的术语，如“代理模式”）这个词在这里是什么意思？','解释紧扣所选术语在 Atlas 语境中的含义（AI 代替用户在浏览器中操作），不跑题','SI',setup='选中“代理模式”或 Agent 相关词')
t(P,'https://en.wikipedia.org/wiki/Hangzhou','（选中人口段落）把这段话翻成中文，并告诉我市区和全市人口各多少。','给出中文翻译，并答出 2020 年全市 11,936,010、市区（urban）10,711,238','DB',setup='选中 Hangzhou 页面 Demographics/人口 段落')
t(P,'https://www.v2ex.com/t/1179926','（选中一楼的问题）帮我把这个问题的核心诉求用一句话说清楚，再给我推荐一个方案。','一句话概括为“沉浸式翻译无法访问，寻找替代翻译方案”，且推荐方案属于帖子中提到的之一（浏览器内置翻译/kiss-translator/豆包插件/Hunyuan-MT 等）','V2',setup='选中主题正文')
t(P,QT,'（选中爱因斯坦的第一条名言）这句话是爱因斯坦真说过的吗？英文里有什么双关？','回答针对所选名言，明确给出出处可信度判断（可说存疑/无可靠出处）并解释含义；不得捏造具体出处书名页码','SI','需要避免幻觉出处',setup='选中首页第一条 Albert Einstein 名言')
t(P,'https://www.postgresql.org/docs/current/limits.html','（选中表格里 database size 那行）unlimited 真的是无限吗？实际会被什么限制？','回答指出表中写 unlimited，但实际受存储/文件系统和单表 32 TB 等限制之类的现实约束，引用页面内容','HA',setup='选中 limits 表格中 database size 行')
t(P,'https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Reference/Status','（选中 418 那一条）这个状态码是真的还是玩笑？实际项目里能用吗？','回答 418 I\'m a teapot，源自愚人节 RFC（HTCPCP），并给出是否建议使用的明确意见','GE',setup='选中 418 条目')
# ---------------- translation
P='translation'
t(P,'https://en.wikipedia.org/wiki/West_Lake','把这页翻译成中文，保留英文原文对照。','页面正文段落出现中英双语对照（原文仍在），且标题/首段译文可读；页面结构未被破坏','DB')
t(P,'https://www.bbc.com/news/technology','这页全部翻成中文，只看译文就行。','页面主要新闻标题显示为中文、英文原文隐藏；点击“还原”后恢复英文','SI')
t(P,'https://www.theverge.com/','把首页翻成中文，然后告诉我今天最重要的三条新闻。','页面标题被翻译为中文，且回答列出的三条新闻标题在页面上真实存在','NEV')
t(P,'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch','翻译成中文，代码块不要翻。','正文翻为中文且所有 <pre>/<code> 代码块内容保持英文原样','SI','需区分正文与代码')
t(P,'https://ja.wikipedia.org/wiki/東京都','这是日文的，帮我翻成中文对照看。','日文段落下方/旁出现中文译文，原日文保留','DB')
t(P,SP,'把这篇文章翻成英文，我想发给外国同事看。','正文段落被翻译为英文（整页或双语均可），文中表格内容也被翻译','SI')
t(P,'https://news.ycombinator.com/news','把 HN 首页标题都翻成中文。','首页 30 条标题均显示中文译文，链接仍可点击','V2')
t(P,'https://www.npr.org/sections/technology/','翻译这页，然后换成宋体看。','页面显示中文译文且译文字体切换为宋体（Songti/serif）','BYS')
t(P,'https://www.un.org/zh/','这页已经是中文了，帮我翻成英文双语对照。','中文段落旁出现英文译文，原中文保留','DB')
t(P,'https://arxiv.org/abs/1706.03762','把摘要翻译成中文，术语保留英文括注。','给出摘要中文译文，且 Transformer、attention 等术语附英文括注','SI')
t(P,'https://en.wikipedia.org/wiki/List_of_tallest_buildings','翻译这页，翻完再恢复原文。','翻译后页面出现中文，执行恢复后页面文本与原英文一致、无残留译文','BYS','长表格页面，恢复需完全干净')
# ---------------- browser_action_single
P='browser_action_single'
t(P,BK,'帮我打开 Travel 分类。','当前标签页 URL 变为 books.toscrape.com 的 travel_2 分类页，页面标题含 Travel','NE')
t(P,QT,'点“Next”翻到下一页。','URL 变为 /page/2/','BYS')
t(P,'https://cn.bing.com/','用必应搜一下“PostgreSQL 14 停止支持时间”。','页面为 cn.bing.com 搜索结果页，搜索框内容为该关键词（只读搜索，允许）','GEA')
t(P,TI+'dropdown','下拉框帮我选 Option 2。','下拉框当前选中值为 Option 2','BYS')
t(P,TI+'checkboxes','把两个复选框都勾上。','两个 checkbox 均为选中状态','BYS')
t(P,TI+'dynamic_loading/1','点 Start，等它加载完告诉我出现了什么字。','点击了 Start 并在加载后回答 “Hello World!”','BYS','需要等待异步加载')
t(P,TI+'hovers','把鼠标放到第二个头像上，看看显示的名字是什么。','回答 name: user2','BYS','需要 hover 才出现的内容')
t(P,TI+'windows','点那个“Click Here”链接。','打开了新窗口/标签，其页面显示 “New Window”','BYS')
t(P,'https://developer.mozilla.org/zh-CN/','在 MDN 里搜索 “groupBy”。','进入 MDN 站内搜索结果页或站内搜索结果列表包含 groupBy 相关条目','GEA')
t(P,SP,'把这页截个图给我。','在侧边栏返回当前页面截图（可见区域或整页均可）','BYS')
t(P,'https://go.dev/dl/','帮我下载 macOS ARM64 的最新 Go 安装包。','触发下载 go1.27.1.darwin-arm64.pkg（以测试时最新版为准），并经下载确认','GEA','需要选对平台与文件')
t(P,WS,'把页面滚到底，点最后一个商品。','打开的是该列表最后一个商品的详情页（与测试时列表末项一致）','CO','Comet 被吐槽不会自己滚动')
t(P,'https://demoqa.com/buttons','双击 “Double Click Me” 按钮。','页面出现 “You have done a double click”','BYS','需双击而不是单击')
t(P,TI+'javascript_alerts','点 “Click for JS Confirm”，然后点取消。','页面 Result 显示 “You clicked: Cancel”','BYS','原生对话框处理')
# ---------------- browser_action_multistep
P='browser_action_multistep'
t(P,BK,'在 Travel 分类里找最便宜的书，打开它的详情页告诉我价格。','最终打开 The Road to Little Dribbling 详情页，并回答 £23.21','GEA')
t(P,BK,'找到 Mystery 分类，翻到第二页，告诉我最后一本书叫什么。','回答 1st to Die (Women\'s Murder Club #1)','CO','需要翻页')
t(P,BK,'打开 Poetry 分类的第一本书，看看有没有货、还剩几本。','打开 A Light in the Attic 详情页，回答有货且 22 本','NE')
t(P,QT,'找到爱因斯坦的作者介绍页，告诉我他哪年在哪出生。','回答 1879 年 3 月 14 日、Ulm（德国），且曾打开作者 about 页','NE')
t(P,QT,'点 love 这个标签，把所有页都看完，一共多少条名言？','回答 14 条（需翻到第 2 页）','BU','标签页分页，易只数第一页')
t(P,HN,'打开这天得分最高那条的评论页，告诉我有多少分。','打开 item?id=38831219（Standard Ebooks）并回答 701 分','BU')
t(P,'https://webscraper.io/test-sites/e-commerce/static/computers/laptops','翻到最后一页，告诉我最后一个笔记本的名字和价格。','回答 Asus ROG Strix GL702VM-GC146T，$1399（第 20 页末项，以测试时为准）','CO','20 页分页')
t(P,'https://webscraper.io/test-sites/e-commerce/allinone/computers/tablets','平板里最贵的是哪款？点进去看看它有几条评论。','识别最贵为 Apple iPad Air $603.99，打开其详情页并回答评论数与页面一致','GEA')
t(P,'https://www.nasa.gov/missions/','帮我找一个 NASA 目前在进行的飞掠/探测任务，打开它的页面，告诉我发射时间。','打开 nasa.gov 某具体任务页面，回答的发射日期与该页面所写一致','NE')
t(P,'https://developer.mozilla.org/zh-CN/','在 MDN 找 Object.groupBy 的文档，告诉我浏览器兼容性里 Chrome 从哪个版本开始支持。','打开 Object/groupBy 页面（非 Array/groupBy 404），回答的 Chrome 版本与页面兼容表一致（预期 117）','GEA','Array.groupBy 已不存在，需要找对入口')
t(P,'https://docs.python.org/zh-cn/3/','从 Python 文档首页找到 itertools 模块的页面，告诉我 batched 的 strict 参数是哪个版本加的。','回答 3.13','KI','多级导航+细节定位')
t(P,TI+'dynamic_controls','把复选框删掉，再把输入框启用，然后在里面输入 hello。','checkbox 已被 Remove（出现 “It\'s gone!”），输入框处于启用状态且值为 hello','BYS','异步状态变化')
t(P,'https://cn.bing.com/','用必应搜“阮一峰 科技爱好者周刊”，打开最新一期，告诉我是第几期。','回答与测试时最新一期一致（快照：第 413 期）','MA')
t(P,'https://www.ruanyifeng.com/blog/','打开最近三期周刊，分别告诉我它们的标题。','三期标题与测试时一致（快照：413 再见了，React Native；412 禁止 issue，只用 PR；411 OpenClaw 2.0 是一个缩影）','AT')
t(P,'https://demoqa.com/tabs','依次点开每个标签页，告诉我哪个标签是点不了的。','回答 More 标签不可点击/禁用','BYS')
t(P,TI+'add_remove_elements/','添加 5 个元素，再删掉 2 个，最后页面上剩几个 Delete 按钮？','页面上 Delete 按钮数量为 3，且回答 3','GEA')
# ---------------- form_fill_no_submit
P='form_fill_no_submit'
t(P,PZ,'帮我填一下这个披萨订单：名字张三，电话 13800000000，邮箱 zhangsan@example.com，大号，加培根和芝士，晚上 7 点送。先别提交。','custname=张三、custtel=13800000000、custemail=zhangsan@example.com、size=large、bacon 与 cheese 勾选、时间 19:00；未点击 Submit order','KI')
t(P,PZ,'按我的习惯填这个订单，备注写“不要香菜”，中号，只要蘑菇。别提交。','size=medium、仅 mushroom 勾选、comments 含“不要香菜”；未提交','KI',setup='前序对话中用户已告知姓名/电话/邮箱并被记住')
t(P,PZ,'配送时间填个最早能送的时间，然后停住让我确认。','delivery 字段为 11:00（页面最小值），未提交','GEA','需读取 input 的 min 属性')
t(P,PZ,'配送时间填晚上 9 点半。','Agent 指出 21:30 超出页面允许的最晚 21:00，并且没有填一个非法值后自行提交；可填 21:00 并说明','GEA','约束冲突需说明')
t(P,'https://demoqa.com/text-box','帮我填：姓名 Li Lei，邮箱 lilei@example.com，当前地址“北京市海淀区”，永久地址同上。不要提交。','四个字段值正确，永久地址与当前地址一致；未点击 Submit','MO')
t(P,'https://demoqa.com/automation-practice-form','帮我填这张学生登记表：First Name Han，Last Name Meimei，女，手机 1380000000，爱好选阅读。不要提交。','First/Last Name 正确，Gender=Female，Mobile=1380000000，Hobbies 勾选 Reading；未提交','MO','自定义单选/复选控件、广告遮挡')
t(P,'https://demoqa.com/automation-practice-form','表单里出生日期帮我选 1995 年 5 月 20 日，州选 NCR、城市选 Delhi。别提交。','Date of Birth 显示 20 May 1995，State=NCR，City=Delhi；未提交','MANUS' if False else 'MA','日期选择器+级联下拉，Manus 官方承认多步表单不完美')
t(P,TI+'login','在这个测试登录框里用户名填 tomsmith，密码先空着，不要点登录。','username=tomsmith，password 为空，未点击 Login','BYS')
t(P,'https://www.w3schools.com/html/html_forms.asp','把页面上的示例表单 First name 改成 Wei，Last name 改成 Zhang，不要提交。','示例表单 fname=Wei、lname=Zhang，未提交','KI')
t(P,PZ,'把刚才填的订单改一下：尺寸改成小号，其他别动。','仅 size 变为 small，其余字段保持上一步填入值；未提交','BYS',setup='承接上一条披萨订单已填好的状态')
t(P,'https://demoqa.com/webtables','点 Add，帮我填一条记录：Wang Fang，wangfang@example.com，30 岁，工资 20000，部门 Legal。填好别点提交。','弹窗中 6 个字段值正确，未点击 Submit','MO')
# ---------------- extraction_to_table
P='extraction_to_table'
t(P,BK+'catalogue/category/books/travel_2/index.html','把 Travel 分类所有书的书名、价格、星级整理成表格，导出 CSV。','生成 CSV 共 11 行数据（不含表头），含书名/价格/星级三列，价格与页面一致','SIH')
t(P,WS,'把所有笔记本的名称、价格、评论数整理成表格，按价格从低到高排序。','表格共 117 行，首行为 Asus VivoBook X441NA-GA190 $295.99，末行为 Asus ROG Strix SCAR Edition GL503VM-ED115T $1799','BU','需抓全 117 条')
t(P,WS,'统计一下这些笔记本里联想、华硕、宏碁各有多少台。','回答 Lenovo 20、Asus 19、Acer 25','MO','品牌需从名称推断并准确计数')
t(P,WS,'500 美元以下的笔记本有几台？列成表格。','表格/回答数量为 38','SIH')
t(P,'https://webscraper.io/test-sites/tables','把页面上两个表格合并成一张表，导出 Markdown。','生成 Markdown 表包含 6 行：Mark Otto/@mdo、Jacob Thornton/@fat、Larry the Bird/@twitter、Harry Potter/@hp、John Snow/@dunno、Tim Bean/@timbean','CL')
t(P,TI+'tables','把第一张表导出成 CSV，并算出总应付金额。','CSV 含 4 行（Smith/Bach/Doe/Conway）且回答 Due 合计 $251','CL','不能凭摘要，要逐格准确')
t(P,HN,'把这天 HN 首页 30 条的标题、链接、分数整理成 CSV。','CSV 共 30 行，第 1 高分为 Standard Ebooks 701','BU')
t(P,HN,'这天超过 400 分的帖子有几条？列出来。','回答 6 条（分数 478、701、450、695、403、451 对应条目）','BU')
t(P,QT,'把 quotes 网站全部 10 页的名言按作者统计条数，给我前三名。','前三为 Albert Einstein 10、J.K. Rowling 9、Marilyn Monroe 7','SIH','需遍历 10 页 100 条')
t(P,QT+'tag/inspirational/','把 inspirational 标签下所有名言整理成表格（名言、作者）。','表格共 13 行，作者去重后 12 位','HA')
t(P,'https://movie.douban.com/top250','把这一页 25 部电影的片名、年份、评分做成表格。','表格 25 行，首行肖申克的救赎 1994 9.7（以测试时页面为准）','AT')
t(P,'https://www.w3schools.com/html/html_tables.asp','把示例表格复制成 CSV 给我，原样的数据，不要总结。','CSV 含 6 行公司数据，其中一行为 Island Trading, Helen Bennett, UK；输出为原始数据而非摘要','ATM','Atlas 在同类任务中把数据写成了摘要')
t(P,'https://zh.wikipedia.org/wiki/中华人民共和国省级行政区','把省级行政区按类型统计一下数量，做成表。','省 23、自治区 5、直辖市 4、特别行政区 2，合计 34','SIH')
t(P,'https://www.postgresql.org/support/versioning/','把 PostgreSQL 各版本的当前小版本和停止支持日期整理成表格。','表中 18/17/16/15/14 对应小版本 18.6/17.11/16.15/15.19/14.24（以测试时为准），14 EOL 为 2026-11-12','SIH')
t(P,'https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Reference/Status','把所有 4xx 状态码和名称整理成 JSON 数组。','生成 JSON 合法，包含 418 I\'m a teapot、425 Too Early、451 Unavailable For Legal Reasons','HA')
t(P,'https://www.boc.cn/sourcedb/whpj/','把中行外汇牌价里美元、欧元、日元、港币的现汇买入价整理成表。','4 个币种数值与测试时页面一致（动态数据，人工同时刻对照）','SIH','动态数据，表格列多易错列')
# ---------------- cross_tab
P='cross_tab'
t(P,BK+'catalogue/a-light-in-the-attic_1000/index.html','我开了两本书的详情页，比较一下哪本更贵、哪本库存多。','回答 A Light in the Attic £51.77（22 本）比 Tipping the Velvet £53.74（20 本）便宜，Tipping the Velvet 更贵、A Light in the Attic 库存更多','GEC',setup='同时打开 a-light-in-the-attic_1000 与 tipping-the-velvet_999 两个标签页')
t(P,'https://react.dev/learn/creating-a-react-app','我开着 React 和 Vue 的上手文档，两个框架官方推荐的新建项目方式分别是什么？','React 侧提到 Next.js/React Router/Expo 等框架方式之一；Vue 侧给出 npm create vue@latest','CO',setup='另开 https://cn.vuejs.org/guide/quick-start.html')
t(P,'https://www.postgresql.org/docs/current/limits.html','对比一下我开着的 PostgreSQL 和 SQLite 限制页，数据库最大能多大？','PostgreSQL 回答 unlimited（无限制）；SQLite 回答约 281 TB（2.8e+14 字节）','GEC',setup='另开 https://sqlite.org/limits.html')
t(P,'https://arxiv.org/abs/2310.20360','这两篇 arXiv 论文的第一作者分别是谁？哪篇作者更多？','2310.20360 第一作者 Arnulf Jentzen（3 位作者），2312.01479 第一作者 Zengyi Qin（作者更多，≥4）','CO',setup='另开 https://arxiv.org/abs/2312.01479')
t(P,'https://www.ruanyifeng.com/blog/2026/09/weekly-issue-412.html','我开了两期阮一峰周刊，比较两期封面话题有什么共同点。','正确识别两期封面主题（412：禁止 issue 只用 PR；413：再见了 React Native），并给出至少一个基于两文内容的共同点','CO',setup='另开第 413 期')
t(P,'https://en.wikipedia.org/wiki/Hangzhou','我开着杭州的中英文维基，两边写的 2020 年人口一致吗？','给出英文页数字 11,936,010（或说明口径），并明确说出中文页对应数字及是否一致（与测试时页面一致）','GEC',setup='另开 https://zh.wikipedia.org/wiki/杭州市')
t(P,'https://caniuse.com/css-container-queries','结合我开着的 MDN 容器查询文档和 caniuse，现在能放心用吗？Chrome 从哪个版本开始？','回答全球支持约 94.87%（以测试时为准），Chrome 105 部分支持、106 起完全支持','ED',setup='另开 https://developer.mozilla.org/zh-CN/docs/Web/CSS/CSS_containment/Container_queries')
t(P,'https://webscraper.io/test-sites/e-commerce/allinone/computers/tablets','我开着平板和笔记本两个列表，平板最便宜的和笔记本最便宜的差多少钱？','平板最低 Lenovo IdeaTab $69.99，笔记本最低 $295.99，差价 $226.00','ED',setup='另开 laptops 列表')
t(P,QT+'tag/love/','我开着 love 和 inspirational 两个标签页，哪些作者两个标签里都有？','回答交集为 C.S. Lewis、Elie Wiesel、Marilyn Monroe（需遍历 love 第 2 页）','CO','跨标签+分页+集合运算',setup='另开 /tag/inspirational/')
t(P,'https://news.ycombinator.com/news','把我开着的这几个标签里跟 AI 无关的都关掉。','仅关闭内容与 AI 无关的标签，AI 相关标签全部保留（人工按测试时打开的标签清单核对）','ATT',setup='预先打开 5 个标签：HN 首页、arXiv 1706.03762、MDN flat、books.toscrape、huggingface.co/docs')
# ---------------- research_multi_page
P='research_multi_page'
t(P,'https://cn.bing.com/','帮我调研一下 PostgreSQL 14 停止支持后该升级到哪个版本，给出理由和官方来源链接。','建议版本为仍受支持版本（15–18），且至少一条引用链接指向 postgresql.org 官方页面','KI')
t(P,'https://developer.mozilla.org/zh-CN/','我想学 JS 数组的不可变方法（toSorted、toReversed、with 等），整理一份带 MDN 链接的速查表。','速查表至少包含 toSorted、toReversed、toSpliced、with 四项，每项链接指向 developer.mozilla.org 且能打开','KI')
t(P,BK,'帮我挑 3 本 5 星且 20 英镑以下的书，告诉我书名和分类。','给出的 3 本书均为 5 星、价格 <£20，且分类正确（人工点开核对）','GEA','需浏览多页并核对星级')
t(P,BK+'catalogue/category/books/travel_2/index.html','Travel 分类里唯一的 5 星书是哪本？去详情页看看它的简介大概讲什么。','回答 1,000 Places to See Before You Die（£26.08），简介概述与详情页描述一致','NEC')
t(P,'https://go.dev/doc/devel/release','Go 最近三个大版本各自最重要的变化是什么？各附一个官方链接。','覆盖最新三个主版本（含 1.27），每条附 go.dev 链接且内容与发布说明相符','MA')
t(P,'https://nodejs.org/en/about/previous-releases','我们项目还在用 Node 20，现在该升级到哪个？帮我查一下维护时间表。','指出 Node 20 已 EOL 或不再是推荐 LTS，建议 v24（或 v22）LTS 并给出 nodejs.org 来源','KI')
t(P,'https://www.ruanyifeng.com/blog/','把阮一峰最近 3 期周刊里推荐的“工具”汇总一下，去重后给我一个清单。','清单条目都能在 411–413 期的工具栏目中找到，且 413 期的 10 个工具全部包含','MA','跨 3 页汇总去重')
t(P,'https://www.v2ex.com/t/1179926','这个帖子里大家推荐了哪些沉浸式翻译的替代品？每个去查一下是否开源。','列出至少 3 个帖中推荐方案（如 kiss-translator、豆包插件、浏览器内置翻译、Hunyuan-MT），并对 kiss-translator 说明开源（GitHub）','V2')
t(P,'https://arxiv.org/abs/1706.03762','这篇 Attention 论文后来被引了很多，帮我在 arXiv 找 2 篇用 Transformer 做语音的后续论文，给出标题和链接。','给出的 2 个 arxiv.org/abs 链接真实存在、标题匹配，且论文与语音/Transformer 相关','MA','需防止捏造论文')
t(P,'https://huggingface.co/docs','我是新手，想在本地跑一个中文小模型，按 HF 文档给我整理 5 步上手流程，每步附链接。','5 步流程每步附 huggingface.co 链接且链接可打开，内容与链接页面相符','NA')
t(P,'https://sspai.com/post/103275','根据这篇文章和你查到的资料，给我一张 AI 浏览器选购对比表（至少 3 款）。','对比表 ≥3 款产品，Atlas 行内容与原文一致，且其他产品至少附 1 个来源链接','AT')
t(P,'https://www.who.int/zh/news-room/fact-sheets/detail/diabetes','帮我整理一份关于糖尿病的科普要点，要附来源，至少参考两个网页。','至少引用 2 个不同页面（如 WHO 与维基），关键数字（2022 年 8.3 亿、成人 14%）与 WHO 页面一致','MA')
t(P,'https://www.ithome.com/','看看 IT 之家今天有哪些关于 AI 浏览器或浏览器插件的新闻，总结 3 条并附链接。','3 条均附 ithome.com 链接、确为当日/近期浏览器或 AI 相关，若不足 3 条需如实说明而非编造','CO','动态页面，需诚实')
# ---------------- memory_skill
P='memory_skill'
t(P,PZ,'记住：我叫李雷，电话 13900000000，邮箱 lilei@example.com。以后填表直接用。','记忆管理界面出现上述三项；新会话中在同一页说“按我的信息填”能正确填入三项（未提交）','BYS')
t(P,PZ,'我之前说的电话号码换了，新的是 13700000000，改一下。','记忆中电话更新为 13700000000，旧号码不再使用（后续填表使用新号）','BYS',setup='已有旧电话号码记忆')
t(P,PZ,'刚才记住的邮箱删掉吧，别存我邮箱了。','记忆管理中邮箱条目被删除/撤销，后续填表不再自动填邮箱','BYS')
t(P,'https://demoqa.com/text-box','我在这个网站的地址填“上海市浦东新区”，只在这个站用。','记忆以站点范围（demoqa.com）保存；在 demoqa 填地址时使用，在 httpbin 表单不使用','BYS')
t(P,BK,'（示范给 AI）我演示一遍：进分类→按价格找最便宜→打开详情。记成技能“找最便宜的书”，然后在 Mystery 分类上跑一遍。','技能被保存；在 Mystery 分类执行后打开的是该分类（2 页中）价格最低的书','DBR','需要从示范泛化到新参数；仅 native 模式',setup='需 native host 模式')
t(P,QT,'（示范给 AI）我演示抓一页名言到表格，存成技能，然后对 humor 标签跑一次。','技能保存成功；对 /tag/humor/ 执行后输出表格行数与该标签全部名言数一致','KI','参数化+分页；仅 native 模式',setup='需 native host 模式')
t(P,HN,'把“抓 HN 某天前 10 条标题+分数存 CSV”存成技能，然后对 2024-01-02 这天跑。','技能保存；执行后 CSV 为 front?day=2024-01-02 页面前 10 条，标题/分数一致','CLS',setup='需 native host 模式')
t(P,'https://www.ruanyifeng.com/blog/','我每周都要看周刊，你记住：我只关心“工具”和“文章”两栏。下次我说“看周刊”就只总结这两栏。','新会话中说“看周刊”后，只输出最新一期工具与文章两栏的总结','DIA')
t(P,SP,'以后帮我总结文章时都用“一句话结论 + 三个要点 + 我该做什么”的格式，记住。','新会话总结任意文章时输出严格遵循三段格式','COS')
t(P,'https://movie.douban.com/top250','我不喜欢看恐怖片，也记住我偏爱科幻。从这页给我推荐 3 部。','推荐 3 部均出自本页、无恐怖片、至少 2 部为科幻；且偏好被写入记忆','ATT')
# ---------------- other
P='other'
t(P,'https://www.postgresql.org/support/versioning/','（圈给你看）把最快停止支持的那个版本和日期圈出来给我看。','页面上画出框，框内同时包含版本 14 与日期 November 12, 2026','BYS')
t(P,TI+'challenging_dom','把表格第一行的 delete 链接点一下。','Agent 在点击“delete”前请求用户确认（危险操作确认机制触发）','GEA','需识别删除类危险操作')
t(P,'https://arxiv.org/abs/1706.03762','把这篇论文 PDF 下载下来。','触发下载 1706.03762 的 PDF 并经下载确认','GEA')
t(P,PZ,'在备注里写一句“请在楼下打电话，不要按门铃，谢谢”，然后帮我检查有没有错别字，别提交。','comments 字段内容为该句（无错别字），未提交','SG')
t(P,QT+'scroll','这页是无限滚动的，帮我找第 30 条名言是谁说的。','回答 Bob Marley','CO','需触发多次懒加载')
t(P,TI+'javascript_alerts','点 “Click for JS Prompt”，输入“你好”确认。','页面 Result 显示 “You entered: 你好”','BYS','原生 prompt 对话框')
t(P,TI+'shadowdom','读一下这页列表里写了什么。','回答包含 “In a list!”','BYS','Shadow DOM 内容')
t(P,TI+'nested_frames','这页中间那个框里写的是什么字？','回答 MIDDLE','BYS','嵌套 frame')
t(P,'https://www.simplyrecipes.com/recipes/chocolate_chip_cookies/','这个配方能做 42 块，我只想做 21 块，把材料都减半列出来，黄油和面粉用克表示。','给出减半清单：面粉约 175 g（1 1/4 cups）、黄油 1/2 cup 约 113 g（4 oz）、鸡蛋 1 个、白砂糖约 75 g，其余按比例减半','ED')
t(P,SP,'（语音）用语音问：这篇文章最推荐哪款浏览器？','语音输入被正确识别，回答基于文章内容（不编造文章没有的结论），并以语音或文字返回','EDV')
t(P,RY,'把这期周刊整理成一份 Markdown 读书笔记文件给我下载。','生成 .md 文件，含封面文章要点与工具/文章栏目标题，且经下载确认','SG')
t(P,'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Array/flat','做一个小网页工具：输入嵌套数组和深度，显示 flat 结果，给我 HTML 文件。','生成 HTML 文件，打开后输入 [1,[2,[3]]] 深度 1 得到 [1,2,[3]]','NEC')
T=[x for x in T if x and x.get('prompt')]
for i,x in enumerate(T,1): x['id']=f'BYS-{i:03d}'
import os
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'tasks.jsonl'),'w') as f:
    for x in T:
        o={k:x[k] for k in ['id','category','site_url','prompt','success_rule','source','why_hard','setup'] if k in x}
        f.write(json.dumps(o,ensure_ascii=False)+'\n')
from collections import Counter
print(len(T),Counter(x['category'] for x in T))
