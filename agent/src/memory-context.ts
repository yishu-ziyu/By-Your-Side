import { usableOnHost, withinValidity, type MemoryEntry } from "../../shared/memory.js";
import type { TaskHistoryEntry } from "../../shared/task-history.js";
import { isRelevantExperience, isRelevantMemory, isRelevantPastTask } from "./memory-relevance.js";

export type MemoryContextRule = "always" | "site" | "in-validity" | "asked";

const MEMORY_CONTEXT_CAPS = {
  facts: { entries: 40, chars: 4000 },
  inValidity: { entries: 10, chars: 2000 },
  siteTasks: { entries: 3, chars: 2400 },
  askedTasks: { entries: 5, chars: 3000 },
} as const;

export const MEMORY_CONTEXT_MAX_CHARS = 9000;

interface MemoryContextInput {
  entries: MemoryEntry[];
  tasks: TaskHistoryEntry[];
  hostname: string | null;
  text: string;
  semanticIds?: readonly string[];
  now: number;
}

export interface MemoryContextSelection {
  entries: Array<{ entry: MemoryEntry; rule: MemoryContextRule }>;
  tasks: Array<{ task: TaskHistoryEntry; rule: MemoryContextRule }>;
  totalChars: number;
  skipped: { replacedOrInvalid: number; expired: number; otherSite: number; notHere: number; overCap: number; notRelevant: number };
}

const ASKED_ABOUT_PAST = /之前|上次|以前|前几天|昨天|做过|订阅过|买过|填过|earlier|last time|before|previously|did you/i;

export function taskContextChars(task: TaskHistoryEntry): number {
  return [task.page ?? "", task.goal, ...task.revisions, ...task.hosts, task.done ?? "", ...task.unfinished].join(" ").length + 40;
}

export function selectMemoryContext(input: MemoryContextInput): MemoryContextSelection {
  const skipped = { replacedOrInvalid: 0, expired: 0, otherSite: 0, notHere: 0, overCap: 0, notRelevant: 0 };
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
  const semanticIds = new Set(input.semanticIds ?? []);
  const facts = { used: 0, chars: 0 };
  const dated = { used: 0, chars: 0 };

  for (const entry of newestFirst) {
    if (entry.status !== "active") { skipped.replacedOrInvalid++; continue; }

    if (entry.scope.kind === "site" && entry.scope.hostname !== input.hostname) { skipped.otherSite++; continue; }

    if (!usableOnHost(entry, input.hostname)) { skipped.notHere++; continue; }

    const rule: MemoryContextRule = entry.scope.kind === "site" ? "site" : "always";

    if (entry.kind === "past") {
      if (!entry.validity || !withinValidity(entry.validity, input.now)) { skipped.expired++; continue; }

      if (take(entry.text.length, dated, MEMORY_CONTEXT_CAPS.inValidity)) pickedEntries.push({ entry, rule: "in-validity" });
      continue;
    }

    if (!withinValidity(entry.validity, input.now)) { skipped.expired++; continue; }

    if (entry.scope.kind === "site" && entry.experience) {
      const relevant = entry.version === 1
        ? semanticIds.has(entry.id) || isRelevantExperience(entry.experience.topic ?? entry.text, input.text)
        : isRelevantMemory(entry.text, input.text);

      if (!relevant) continue;
    } else if (entry.experience && entry.version === 1 && !semanticIds.has(entry.id) && !isRelevantExperience(entry.experience.topic ?? entry.text, input.text)) continue;

    if (take(entry.text.length, facts, MEMORY_CONTEXT_CAPS.facts)) pickedEntries.push({ entry, rule });
  }

  const usable = input.tasks.filter(task => usableOnHost(task, input.hostname));
  skipped.notHere += input.tasks.length - usable.length;
  const tasks = usable.sort((a, b) => b.endedAt - a.endedAt);
  const chosen = new Set<string>();

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

      if (!isRelevantPastTask([task.goal, ...task.revisions].join("\n"), input.text)) { skipped.notRelevant++; continue; }

      if (take(taskContextChars(task), here, MEMORY_CONTEXT_CAPS.siteTasks)) { pickedTasks.push({ task, rule: "site" }); chosen.add(task.id); }
    }
  }

  return { entries: pickedEntries, tasks: pickedTasks, totalChars, skipped };
}
