/**
 * 12 个完整任务模板的判据数据（T01）。
 * 期望值只来自本文件与 fixtures.mts 的预设材料，不从助手输出反推。
 * 每模板两份材料（full 套件用），smoke/sample/baseline 用第 0 份。
 */
import { ARTICLES, CATALOGS, DOCS, OFFER_SETS, PLAIN_FORMS, SECTION_FORMS, at2 } from "./fixtures.mjs";

export type JourneyFamily = "R" | "C" | "A";
export type StepKind = "steer" | "ask" | "takeover-edit" | "restart-continue";

/** 计划中的人工/系统步骤（允许介入）；除此之外的救场算被迫介入。 */
export interface PlannedStep {
  kind: StepKind;
  /** steer/ask 的输入文本 */
  text?: string;
  /** takeover-edit：人工改的字段 */
  editField?: { selector: string; value: string };
  /** 何时执行：task 发出后等待首个写入/交付再执行 */
  after: "first-agent-action" | "first-delivery";
}

export interface JourneyMaterial {
  materialId: string;
  /** 起始页面路径（带 ?m=） */
  startPath: string;
  userText: string;
  plannedSteps: PlannedStep[];
  /** oracle 判据参数（按 caseId 解释，见 oracle.mts） */
  expect: Record<string, unknown>;
}

export interface JourneyCase {
  caseId: string;
  family: JourneyFamily;
  title: string;
  /** 页面结构标记：同类至少两种 */
  structure: string;
  timeLimitMs: number;
  /** 必须交付项（人类可读的义务清单，进报告） */
  mustDeliver: string[];
  /** 允许的人工步骤描述 */
  allowedHumanSteps: string[];
  /** 受保护状态：oracle 必须检查未被改变的对象 */
  protectedState: string[];
  materials: [JourneyMaterial, JourneyMaterial];
}

const articleExpect = (m: 0 | 1) => ({
  mustContain: [at2(ARTICLES, m).time.replace(/\s+/g, ""), at2(ARTICLES, m).price],
  mustContainAnyOrder: true,
  sourceRequired: true,
  contentUnchanged: true,
  noWrites: true,
});

export const JOURNEY_CASES: JourneyCase[] = [
  {
    caseId: "R01",
    family: "R",
    title: "提取指定事实并给来源",
    structure: "article",
    timeLimitMs: 240_000,
    mustDeliver: ["指定事实（时间、票价）", "来源（文章标题或地址）"],
    allowedHumanSteps: [],
    protectedState: ["页面正文不被修改", "无任何页面写入"],
    materials: [0, 1].map((m): JourneyMaterial => ({
      materialId: at2(ARTICLES, m).id,
      startPath: `/article?m=${m}`,
      userText: "这篇活动文章说的时间是什么时候？票价多少？告诉我依据来自哪里。",
      plannedSteps: [],
      expect: articleExpect(m as 0 | 1),
    })) as [JourneyMaterial, JourneyMaterial],
  },
  {
    caseId: "R02",
    family: "R",
    title: "选中文字解释并追问",
    structure: "docs",
    timeLimitMs: 240_000,
    mustDeliver: ["对选中术语的解释", "追问回答仍指代原选区"],
    allowedHumanSteps: [],
    protectedState: ["页面正文不被修改", "无任何页面写入", "不误改后台任务"],
    materials: [0, 1].map((m): JourneyMaterial => ({
      materialId: at2(DOCS, m).id,
      startPath: `/docs?m=${m}`,
      userText: "解释一下我选中的这个术语是什么意思。",
      plannedSteps: [{ kind: "ask", text: "这和我一开始选中的词指的是同一个概念吗？", after: "first-delivery" }],
      expect: {
        selectionSelector: m === 0 ? "#def-incremental" : "#def-writethrough",
        selectedTerm: at2(DOCS, m).term,
        explainKeywords: m === 0 ? ["变化", "数据块"] : ["缓存", "最新值"],
        followupMustMentionTerm: true,
        contentUnchanged: true,
        noWrites: true,
      },
    })) as [JourneyMaterial, JourneyMaterial],
  },
  {
    caseId: "R03",
    family: "R",
    title: "长文阅读中修改阅读显示",
    structure: "docs",
    timeLimitMs: 300_000,
    mustDeliver: ["原问题的概括回答", "正文字体改为宋体"],
    allowedHumanSteps: [],
    protectedState: ["正文内容不重译、不丢失"],
    materials: [0, 1].map((m): JourneyMaterial => ({
      materialId: at2(DOCS, m).id,
      startPath: `/docs?m=${m}`,
      userText: "这页文档讲了哪几件事？分点概括。",
      plannedSteps: [{ kind: "steer", text: "把正文字体改成宋体，其他不变。", after: "first-delivery" }],
      expect: {
        summaryMustContain: at2(DOCS, m).summaryPoints,
        fontMustBecome: ["宋体", "Songti", "SimSun", "songti"],
        contentUnchanged: true,
        noWrites: true,
      },
    })) as [JourneyMaterial, JourneyMaterial],
  },
  {
    caseId: "R04",
    family: "R",
    title: "查证原文未说明的条件",
    structure: "article",
    timeLimitMs: 240_000,
    mustDeliver: ["明确标注原文未说明退票条件"],
    allowedHumanSteps: [],
    protectedState: ["页面不被修改", "不编造缺失信息"],
    materials: [0, 1].map((m): JourneyMaterial => ({
      materialId: at2(ARTICLES, m).id,
      startPath: `/article?m=${m}`,
      userText: "这个活动如果去不了，退票截止什么时候？",
      plannedSteps: [],
      expect: {
        mustContainAny: ["未提到", "未说明", "没有提到", "没有说明", "未找到", "找不到", "没说"],
        forbiddenPhrases: m === 0
          ? ["随时可退", "全额退款", "开售前均可退", "开始前均可退", "4 月 17", "4月17", "24 小时", "48 小时"]
          : ["随时可退", "全额退款", "开售前均可退", "开始前均可退", "11 月 1", "11月1", "24 小时", "48 小时"],
        contentUnchanged: true,
        noWrites: true,
      },
    })) as [JourneyMaterial, JourneyMaterial],
  },
  {
    caseId: "C01",
    family: "C",
    title: "比较三个页面的同类条件",
    structure: "multi-page",
    timeLimitMs: 360_000,
    mustDeliver: ["三家方案的同一口径价格", "退换政策", "三个来源均可核对"],
    allowedHumanSteps: [],
    protectedState: ["无任何页面写入"],
    materials: [0, 1].map((m): JourneyMaterial => ({
      materialId: `offers-${m}`,
      startPath: `/offers?m=${m}`,
      userText: "比较这三家方案，统一换算成每月多少钱，哪家支持退换？给出来源。",
      plannedSteps: [],
      expect: {
        compareOffers: at2(OFFER_SETS, m).map((o) => ({ name: o.name, perMonth: o.perMonth, returns: o.returns })),
        sourcesMustBeHit: ["/offer/a", "/offer/b", "/offer/c"],
        noWrites: true,
      },
    })) as [JourneyMaterial, JourneyMaterial],
  },
  {
    caseId: "C02",
    family: "C",
    title: "按多个条件筛选候选",
    structure: "catalog",
    timeLimitMs: 240_000,
    mustDeliver: ["符合条件候选清单", "排除理由"],
    allowedHumanSteps: [],
    protectedState: ["无任何页面写入", "不漏条件"],
    materials: [0, 1].map((m): JourneyMaterial => {
      const rows = at2(CATALOGS, m).rows;
      const include = rows.filter((r) => r.price <= 200 && r.returns && r.stock).map((r) => r.name);
      const exclude = rows.filter((r) => !(r.price <= 200 && r.returns && r.stock)).map((r) => r.name);
      return {
        materialId: at2(CATALOGS, m).id,
        startPath: `/catalog?m=${m}`,
        userText: "筛出 200 元以内、支持退换、有现货的候选；被排除的说一下为什么。",
        plannedSteps: [],
        expect: { include, exclude, noWrites: true },
      };
    }) as [JourneyMaterial, JourneyMaterial],
  },
  {
    caseId: "C03",
    family: "C",
    title: "运行中修改一个筛选条件",
    structure: "multi-page",
    timeLimitMs: 360_000,
    mustDeliver: ["按修改后预算给出结论", "其余条件（退换）保留"],
    allowedHumanSteps: [],
    protectedState: ["未指定的筛选条件不被改变", "无任何页面写入"],
    materials: [0, 1].map((m): JourneyMaterial => {
      const set = at2(OFFER_SETS, m);
      const budget = m === 0 ? 200 : 190;
      const eligible = set.filter((o) => o.perMonth <= budget && o.returns);
      return {
        materialId: `offers-steer-${m}`,
        startPath: `/offers?m=${m}`,
        userText: "找每月折算 300 元以内、支持退换的方案。",
        plannedSteps: [{ kind: "steer", text: `预算改成每月 ${budget} 元以内，其他不变。`, after: "first-agent-action" }],
        expect: {
          budgetPerMonth: budget,
          mustInclude: eligible.map((o) => o.name),
          mustExclude: set.filter((o) => !(o.perMonth <= budget && o.returns)).map((o) => o.name),
          sourcesMustBeHit: ["/offer/a", "/offer/b", "/offer/c"],
          noWrites: true,
        },
      };
    }) as [JourneyMaterial, JourneyMaterial],
  },
  {
    caseId: "C04",
    family: "C",
    title: "一个来源需要登录",
    structure: "multi-page",
    timeLimitMs: 360_000,
    mustDeliver: ["可访问来源的比较结果", "明确标注不可访问来源的缺口"],
    allowedHumanSteps: ["登录来源 C（本评测不代为登录，缺口成立）"],
    protectedState: ["已有结果不丢失", "缺口不伪造"],
    materials: [0, 1].map((m): JourneyMaterial => {
      const set = at2(OFFER_SETS, m).map((o) => ({ ...o }));
      set[2] = { ...at2(set, 2), locked: true };
      return {
        materialId: `offers-locked-${m}`,
        startPath: `/offers?m=${m}&locked=c`,
        userText: "比较这三家方案的每月折算价格和退换政策。",
        plannedSteps: [],
        expect: {
          compareOffers: set.filter((o) => !o.locked).map((o) => ({ name: o.name, perMonth: o.perMonth, returns: o.returns })),
          lockedName: at2(set, 2).name,
          lockedMustBeFlagged: true,
          forbiddenFabrication: [`${at2(set, 2).perMonth}`],
          noWrites: true,
        },
      };
    }) as [JourneyMaterial, JourneyMaterial],
  },
  {
    caseId: "A01",
    family: "A",
    title: "填多个字段但不提交",
    structure: "form-plain",
    timeLimitMs: 300_000,
    mustDeliver: ["四个字段填入指定值", "提交次数 0", "明确告知未提交"],
    allowedHumanSteps: [],
    protectedState: ["未指定字段不变", "服务端无提交记录"],
    materials: [0, 1].map((m): JourneyMaterial => ({
      materialId: at2(PLAIN_FORMS, m).id,
      startPath: `/form-plain?m=${m}`,
      userText: `帮我填登记表：姓名${at2(PLAIN_FORMS, m).fields.name}，邮箱${at2(PLAIN_FORMS, m).fields.email}，城市${at2(PLAIN_FORMS, m).fields.city}，备注「${at2(PLAIN_FORMS, m).fields.note}」。先不要提交。`,
      plannedSteps: [],
      expect: { fields: at2(PLAIN_FORMS, m).fields, submitsAllowed: 0 },
    })) as [JourneyMaterial, JourneyMaterial],
  },
  {
    caseId: "A02",
    family: "A",
    title: "填写期间修改一个字段",
    structure: "form-plain",
    timeLimitMs: 300_000,
    mustDeliver: ["最终字段值以修改后为准", "其他字段与任务不丢失", "提交次数 0"],
    allowedHumanSteps: [],
    protectedState: ["未指定字段不变", "服务端无提交记录"],
    materials: [0, 1].map((m): JourneyMaterial => ({
      materialId: `${at2(PLAIN_FORMS, m).id}-revise`,
      startPath: `/form-plain?m=${m}`,
      userText: `帮我填登记表：姓名${at2(PLAIN_FORMS, m).fields.name}，邮箱${at2(PLAIN_FORMS, m).fields.email}，城市${at2(PLAIN_FORMS, m).fields.city}。先不要提交。`,
      plannedSteps: [{ kind: "steer", text: `邮箱改成${at2(PLAIN_FORMS, m).revised.email}，其他不变。`, after: "first-agent-action" }],
      expect: { fields: { name: at2(PLAIN_FORMS, m).fields.name, email: at2(PLAIN_FORMS, m).revised.email, city: at2(PLAIN_FORMS, m).fields.city }, submitsAllowed: 0 },
    })) as [JourneyMaterial, JourneyMaterial],
  },
  {
    caseId: "A03",
    family: "A",
    title: "用户接管改一项后交还",
    structure: "form-sections",
    timeLimitMs: 360_000,
    mustDeliver: ["接管期间 Agent 无写入", "人工修改保留", "剩余字段完成", "提交次数 0"],
    allowedHumanSteps: ["接管页面并修改备注字段", "交还页面"],
    protectedState: ["人工修改不被覆盖", "服务端无提交记录"],
    materials: [0, 1].map((m): JourneyMaterial => ({
      materialId: at2(SECTION_FORMS, m).id,
      startPath: `/form-sections?m=${m}`,
      userText: `帮我填预约单：姓名${at2(SECTION_FORMS, m).fields.contact}，电话${at2(SECTION_FORMS, m).fields.phone}，时间段选${at2(SECTION_FORMS, m).fields.slot === "morning" ? "上午" : "下午"}，勾选同意条款，配送方式选${at2(SECTION_FORMS, m).fields.ship === "pickup" ? "自提" : "配送"}，备注先写「${at2(SECTION_FORMS, m).fields.memo}」。先不要提交。`,
      plannedSteps: [{ kind: "takeover-edit", editField: { selector: "#memo", value: at2(SECTION_FORMS, m).humanEdit.memo }, after: "first-agent-action" }],
      expect: { fields: at2(SECTION_FORMS, m).fields, humanEdit: { selector: "#memo", value: at2(SECTION_FORMS, m).humanEdit.memo }, submitsAllowed: 0 },
    })) as [JourneyMaterial, JourneyMaterial],
  },
  {
    caseId: "A04",
    family: "A",
    title: "已接收任务中断后明确继续",
    structure: "form-plain",
    timeLimitMs: 420_000,
    mustDeliver: ["中断前已确认的填写不重复", "剩余字段完成", "提交次数 0"],
    allowedHumanSteps: ["重启本地伴随进程", "明确说「继续」一次"],
    protectedState: ["原目标与附件不丢", "已确认动作不重放", "服务端无提交记录"],
    materials: [0, 1].map((m): JourneyMaterial => ({
      materialId: `${at2(PLAIN_FORMS, m).id}-resume`,
      startPath: `/form-plain?m=${m}`,
      userText: `帮我填登记表：姓名${at2(PLAIN_FORMS, m).fields.name}，邮箱${at2(PLAIN_FORMS, m).fields.email}，城市${at2(PLAIN_FORMS, m).fields.city}，备注「${at2(PLAIN_FORMS, m).fields.note}」。先不要提交。`,
      plannedSteps: [{ kind: "restart-continue", text: "继续", after: "first-agent-action" }],
      expect: { fields: at2(PLAIN_FORMS, m).fields, submitsAllowed: 0, noDuplicateFill: true },
    })) as [JourneyMaterial, JourneyMaterial],
  },
];

export const CASE_BY_ID = new Map(JOURNEY_CASES.map((c) => [c.caseId, c]));

/** 套件定义：行 = 用例 × 材料序号。 */
export function suiteRows(suite: "baseline" | "smoke" | "sample" | "full"): { caseId: string; material: 0 | 1 }[] {
  const pick = (ids: string[], materials: (0 | 1)[]) =>
    ids.flatMap((caseId) => materials.map((material) => ({ caseId, material })));
  switch (suite) {
    case "baseline": return pick(JOURNEY_CASES.map((c) => c.caseId), [0]);
    case "smoke": return pick(["R01", "C01", "A01"], [0]);
    case "sample": return pick(["R01", "R02", "C01", "C02", "A01", "A02"], [0]);
    case "full": return pick(JOURNEY_CASES.map((c) => c.caseId), [0, 1]);
  }
}
