/**
 * 主任务的思考档位：每次模型调用前按当前模型取档（能力只从 shared/model-capabilities.ts 读）。
 *
 * - 起始档：中档；模型没有中档时取不高于中档的最高一档，没有就取最低档（不低于模型最低档）。
 * - 升档：宿主已记录的四种信号各让之后的调用升一档，不超过模型最高档；不为判断难度额外调用模型。
 * - 新任务回到起始档。每次实际变化写一行 effort_change{from, to, signal}。
 * 只存「比起始档高几档」，换模型（含故障切换）时按新模型的档位表重新换算。
 */
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { thinkingProfile } from "../../shared/model-capabilities.js";

export type EffortSignal = "tool_failures" | "no_progress" | "goal_unfinished" | "user_correction" | "new_task";

const START: ModelThinkingLevel = "medium";

const ORDER: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function startIndex(levels: readonly ModelThinkingLevel[]): number {
  const atOrBelow = levels.filter(level => ORDER.indexOf(level) <= ORDER.indexOf(START));

  return atOrBelow.length ? levels.indexOf(atOrBelow.at(-1)!) : 0;
}

export class MainEffort {
  private raised = 0;

  constructor(private readonly record: (type: "effort_change", data: { from: ModelThinkingLevel; to: ModelThinkingLevel; signal: EffortSignal }) => void) {}

  /** 这次调用该用的档。 */
  level(model: Model<Api>): ModelThinkingLevel {
    const { levels } = thinkingProfile(model);

    return levels[Math.min(startIndex(levels) + this.raised, levels.length - 1)]!;
  }

  /** 出现升档信号：之后的调用升一档；已在最高档时不变、不记。 */
  raise(model: Model<Api> | undefined, signal: Exclude<EffortSignal, "new_task">): void {
    if (!model) return;
    const from = this.level(model);
    this.raised += 1;
    const to = this.level(model);

    if (to === from) {
      this.raised -= 1;

      return;
    }

    this.record("effort_change", { from, to, signal });
  }

  /** 新任务：回到起始档。 */
  reset(model: Model<Api> | undefined): void {
    if (!this.raised) return;
    const from = model ? this.level(model) : undefined;
    this.raised = 0;

    if (model && from !== this.level(model)) this.record("effort_change", { from: from!, to: this.level(model), signal: "new_task" });
  }
}
