/**
 * 决定点 B：这一轮带哪些记忆给助手。纯代码规则，不问模型（docs/memory-model.md「每次干活前带哪些」）：
 *
 * - 总是带（always）：生效的「关于你」与到处适用的「做事的方法」；
 * - 有效期内（in-validity）：有效期没过的「做过的事」与过往任务，不论在哪个网站；
 * - 按网站带（site）：网站范围与当前网址主机名精确相同的记忆，以及这个网站最近几条过往任务；
 * - 问起过往（asked）：这句话在问「之前 / 上次」做过什么时，带最近几条过往任务（不限网站）。
 *
 * 每层各有上限，总字数不超过 MEMORY_CONTEXT_MAX_CHARS。被替换、失效、过期、别的网站的不带；用户在当前网站点过「这里别用」的也不带。
 */
import { usableOnHost, withinValidity, type MemoryEntry } from "../../shared/memory.js";
import type { TaskHistoryEntry } from "../../shared/task-history.js";
import { isRelevantExperience, isRelevantMemory } from "./memory-relevance.js";

export type MemoryContextRule = "always" | "site" | "in-validity" | "asked";

/** 每层上限：条数与字数。「关于你」沿用升级前的 40 条 / 4000 字。 */
export const MEMORY_CONTEXT_CAPS = {
  facts: { entries: 40, chars: 4000 },
  inValidity: { entries: 10, chars: 2000 },
  siteTasks: { entries: 3, chars: 2400 },
  askedTasks: { entries: 5, chars: 3000 },
} as const;

/** 每轮带的记忆总字数上限（各层上限之和再收紧），保证不挤占任务上下文。 */
export const MEMORY_CONTEXT_MAX_CHARS = 9000;

export interface MemoryContextInput {
  entries: MemoryEntry[];
  tasks: TaskHistoryEntry[];
  /** 当前网址的主机名；没有网页时为 null。 */
  hostname: string | null;
  /** 用户这句原话：判断是否在问过往、自动总结的网站做法是否对得上这件事。 */
  text: string;
  now: number;
}

export interface MemoryContextSelection {
  entries: Array<{ entry: MemoryEntry; rule: MemoryContextRule }>;
  tasks: Array<{ task: TaskHistoryEntry; rule: MemoryContextRule }>;
  totalChars: number;
  /** 没带的条数与原因，写进决定记录。 */
  skipped: { replacedOrInvalid: number; expired: number; otherSite: number; notHere: number; overCap: number };
}

const ASKED_ABOUT_PAST = /之前|上次|以前|前几天|昨天|做过|订阅过|买过|填过|earlier|last time|before|previously|did you/i;

/** 过往任务给模型看的一行有多长：与 formatTaskHistory 的内容一致，只用来计字数上限。 */
export function taskContextChars(task: TaskHistoryEntry): number {
  return [task.page ?? "", task.goal, ...task.revisions, ...task.hosts, task.summary, ...task.unfinished].join(" ").length + 40;
}

export function selectMemoryContext(input: MemoryContextInput): MemoryContextSelection {
  const skipped = { replacedOrInvalid: 0, expired: 0, otherSite: 0, notHere: 0, overCap: 0 };
  const pickedEntries: MemoryContextSelection["entries"] = [];
  const pickedTasks: MemoryContextSelection["tasks"] = [];
  let totalChars = 0;

  const take = (chars: number, layer: { used: number; chars: number }, cap: { entries: number; chars: number }): boolean => {
    if (layer.used >= cap.entries || layer.chars + chars > cap.chars || totalChars + chars > MEMORY_CONTEXT_MAX_CHARS) {
      skipped.overCap++;

      return false;
    }

    layer.used++;
    layer.chars += chars;
    totalChars += chars;

    return true;
  };

  const newestFirst = [...input.entries].sort((a, b) => b.updatedAt - a.updatedAt);
  const facts = { used: 0, chars: 0 };
  const dated = { used: 0, chars: 0 };

  for (const entry of newestFirst) {
    if (entry.status !== "active") { skipped.replacedOrInvalid++; continue; }

    if (entry.scope.kind === "site" && entry.scope.hostname !== input.hostname) { skipped.otherSite++; continue; }

    if (!usableOnHost(entry, input.hostname)) { skipped.notHere++; continue; }

    const rule: MemoryContextRule = entry.scope.kind === "site" ? "site" : "always";

    if (entry.kind === "past") {
      // 做过的事只在有效期内主动带；没有有效期或已过期的留给「查过往」。
      if (!entry.validity || !withinValidity(entry.validity, input.now)) { skipped.expired++; continue; }

      if (take(entry.text.length, dated, MEMORY_CONTEXT_CAPS.inValidity)) pickedEntries.push({ entry, rule: "in-validity" });
      continue;
    }

    if (!withinValidity(entry.validity, input.now)) { skipped.expired++; continue; }

    // 自动总结的网站做法要对得上这件事，不论改过几次：没改过的按对象严格对，用户改过或恢复过的按词宽松对
    // （与 MemoryStore.select 一致）。用户确认过的网站做法（method，不是自动总结）在该网站总是带，不按字面筛；
    // 到处适用的做法与用户自述的事实照常带。
    if (entry.scope.kind === "site" && entry.experience) {
      const relevant = entry.experience && entry.version === 1 ? isRelevantExperience(entry.experience.topic ?? entry.text, input.text) : isRelevantMemory(entry.text, input.text);

      if (!relevant) continue;
    } else if (entry.experience && entry.version === 1 && !isRelevantExperience(entry.experience.topic ?? entry.text, input.text)) continue;

    if (take(entry.text.length, facts, MEMORY_CONTEXT_CAPS.facts)) pickedEntries.push({ entry, rule });
  }

  const usable = input.tasks.filter(task => usableOnHost(task, input.hostname));
  skipped.notHere += input.tasks.length - usable.length;
  const tasks = usable.sort((a, b) => b.endedAt - a.endedAt);
  const chosen = new Set<string>();

  // 过期的带日期任务只在被问起时出现（asked 层），不走有效期层，也不走网站层。
  const expiredIds = new Set<string>();

  for (const task of tasks) {
    if (!task.validity) continue;

    if (!withinValidity(task.validity, input.now)) { skipped.expired++; expiredIds.add(task.id); continue; }

    if (take(taskContextChars(task), dated, MEMORY_CONTEXT_CAPS.inValidity)) { pickedTasks.push({ task, rule: "in-validity" }); chosen.add(task.id); }
  }

  if (ASKED_ABOUT_PAST.test(input.text)) {
    const asked = { used: 0, chars: 0 };

    for (const task of tasks) {
      if (asked.used >= MEMORY_CONTEXT_CAPS.askedTasks.entries) break;

      if (chosen.has(task.id)) continue;

      if (take(taskContextChars(task), asked, MEMORY_CONTEXT_CAPS.askedTasks)) { pickedTasks.push({ task, rule: "asked" }); chosen.add(task.id); }
    }
  } else if (input.hostname) {
    const here = { used: 0, chars: 0 };

    for (const task of tasks) {
      if (here.used >= MEMORY_CONTEXT_CAPS.siteTasks.entries) break;

      if (chosen.has(task.id) || expiredIds.has(task.id) || !task.hosts.includes(input.hostname)) continue;

      if (take(taskContextChars(task), here, MEMORY_CONTEXT_CAPS.siteTasks)) { pickedTasks.push({ task, rule: "site" }); chosen.add(task.id); }
    }
  }

  return { entries: pickedEntries, tasks: pickedTasks, totalChars, skipped };
}
