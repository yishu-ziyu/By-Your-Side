/* 一轮真实任务的时间表（单位：秒，模拟时间）。
   任务：打开 Studio Ghibli 维基词条，把宫崎骏导演的电影按年份列出来。
   kind: think 思考 · prep 准备动作（不计数、不列出，只在「现在」那行露一下）· act 一件事 · note 一句提示 · write 写回答
   live = 进行中那一行（动词 / 对象），past = 做完后的人话，short = 胶囊用的短名，raw = 现在产品里的叫法（复刻「现状」用）。 */
window.RUNS = {
  ok: {
    name: "顺利",
    end: 62.0,
    steps: [
      { id: "t1", kind: "think", s: 0, e: 2.6 },
      { id: "p1", kind: "prep", s: 2.6, e: 3.0, live: ["正在看", "你在哪一页"], raw: "定位当前页" },
      { id: "a1", kind: "act", s: 3.0, e: 5.4, live: ["正在打开", "Studio Ghibli 词条"], past: ["打开了", "Studio Ghibli 词条"], short: "打开词条", raw: "打开页面 en.wikipedia.org", rawPast: "打开了 Studio Ghibli - Wikipedia" },
      { id: "p2", kind: "prep", s: 5.4, e: 6.0, live: ["正在读", "这一页"], raw: "读取页面结构" },
      { id: "a2", kind: "act", s: 6.0, e: 6.4, live: ["正在确认", "是不是这个词条"], past: ["确认是", "Studio Ghibli 词条"], short: "确认词条", raw: "执行脚本", rawPast: "确认当前页面为 Studio Ghibli 词条" },
      { id: "t2", kind: "think", s: 6.4, e: 46.8 },
      { id: "a3", kind: "act", s: 46.8, e: 47.5, live: ["正在展开", "「作品」一节"], past: ["展开了", "「作品」一节"], short: "展开作品", raw: "点「Works」", rawPast: "执行脚本" },
      { id: "a4", kind: "act", s: 47.5, e: 51.3, live: ["正在读", "作品表"], past: ["读出作品表，", "共 26 部"], short: "读作品表", raw: "执行脚本", rawPast: "执行脚本" },
      { id: "a5", kind: "act", s: 51.3, e: 51.8, live: ["正在挑出", "宫崎骏导演的"], past: ["挑出", "宫崎骏导演的 11 部"], short: "挑出 11 部", raw: "执行脚本", rawPast: "确认当前页面为 Studio Ghibli 词条" },
      { id: "t3", kind: "think", s: 51.8, e: 58.0 },
      { id: "a6", kind: "act", s: 58.0, e: 58.6, live: ["正在圈出", "这 11 部"], past: ["在页面上圈出", "这 11 部"], short: "圈出 11 部", raw: "圈出「宫崎骏」", rawPast: "执行脚本" },
      { id: "w", kind: "write", s: 58.6, e: 62.0, live: ["正在写", "回答"] },
    ],
  },
  err: {
    name: "中途出错",
    end: 64.9,
    steps: [
      { id: "t1", kind: "think", s: 0, e: 2.6 },
      { id: "p1", kind: "prep", s: 2.6, e: 3.0, live: ["正在看", "你在哪一页"], raw: "定位当前页" },
      { id: "a1", kind: "act", s: 3.0, e: 5.4, live: ["正在打开", "Studio Ghibli 词条"], past: ["打开了", "Studio Ghibli 词条"], short: "打开词条", raw: "打开页面 en.wikipedia.org", rawPast: "打开了 Studio Ghibli - Wikipedia" },
      { id: "p2", kind: "prep", s: 5.4, e: 6.0, live: ["正在读", "这一页"], raw: "读取页面结构" },
      { id: "a2", kind: "act", s: 6.0, e: 6.4, live: ["正在确认", "是不是这个词条"], past: ["确认是", "Studio Ghibli 词条"], short: "确认词条", raw: "执行脚本", rawPast: "确认当前页面为 Studio Ghibli 词条" },
      { id: "t2", kind: "think", s: 6.4, e: 46.8 },
      { id: "a3x", kind: "act", failed: true, s: 46.8, e: 48.3, live: ["正在展开", "「作品」一节"], past: ["没展开", "「作品」一节"], why: "没找到这个按钮", short: "展开作品", raw: "点「Works」", rawPast: "点「Works」" },
      { id: "n1", kind: "note", s: 48.3, e: 49.4, live: ["没找到按钮，", "改成滚过去找"] },
      { id: "a3b", kind: "act", s: 49.4, e: 50.4, live: ["正在滚到", "「作品」一节"], past: ["滚到了", "「作品」一节"], short: "滚到作品", raw: "滚动页面", rawPast: "执行脚本" },
      { id: "a4", kind: "act", s: 50.4, e: 54.2, live: ["正在读", "作品表"], past: ["读出作品表，", "共 26 部"], short: "读作品表", raw: "执行脚本", rawPast: "执行脚本" },
      { id: "a5", kind: "act", s: 54.2, e: 54.7, live: ["正在挑出", "宫崎骏导演的"], past: ["挑出", "宫崎骏导演的 11 部"], short: "挑出 11 部", raw: "执行脚本", rawPast: "执行脚本" },
      { id: "t3", kind: "think", s: 54.7, e: 60.9 },
      { id: "a6", kind: "act", s: 60.9, e: 61.5, live: ["正在圈出", "这 11 部"], past: ["在页面上圈出", "这 11 部"], short: "圈出 11 部", raw: "圈出「宫崎骏」", rawPast: "执行脚本" },
      { id: "w", kind: "write", s: 61.5, e: 64.9, live: ["正在写", "回答"] },
    ],
  },
};

window.USER_ASK = "打开吉卜力工作室的维基词条，把宫崎骏导演的电影按年份列给我。";
window.ANSWER = [
  "宫崎骏在吉卜力导演了 11 部长片：",
  "1984 风之谷 · 1986 天空之城 · 1988 龙猫 · 1989 魔女宅急便 · 1992 红猪 · 1997 幽灵公主 · ",
  "+2001 千与千寻 · 2004 哈尔的移动城堡 · 2008 悬崖上的金鱼姬 · 2013 起风了 · 2023 你想活出怎样的人生。",
  "页面上已把这 11 部圈出来了。",
];
