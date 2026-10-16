/**
 * 主任务的思考档位：每次模型调用前按当前模型取档（能力只从 shared/model-capabilities.ts 读）。
 *
 * - 起始档：中档（实测登记了起始档的模型用登记的档）；模型没有该档时取不高于中档的最高一档，没有就取最低档（不低于模型最低档）。
 * - 升档：宿主已记录的四种信号各让之后的调用升一档，不超过模型最高档；不为判断难度额外调用模型。
 * - 新任务回到起始档。每次实际变化写一行 effort_change{from, to, signal}。
 * 只存「比起始档高几档」，换模型（含故障切换）时按新模型的档位表重新换算。
 * 用户手动选择的档位按模型保存为起始档；后续自动升档不改写这份偏好。
 */
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { thinkingProfile } from "../../shared/model-capabilities.js";

export type EffortSignal = "tool_failures" | "no_progress" | "goal_unfinished" | "user_correction" | "new_task";

const START: ModelThinkingLevel = "medium";

const ORDER: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function startIndex(levels: readonly ModelThinkingLevel[], start: ModelThinkingLevel = START): number {
  const atOrBelow = levels.filter(level => ORDER.indexOf(level) <= ORDER.indexOf(start));

  return atOrBelow.length ? levels.indexOf(atOrBelow.at(-1)!) : 0;
}

export function thinkingChoice(model: Model<Api>): { levels: ModelThinkingLevel[]; default: ModelThinkingLevel } | undefined {
  const { levels, start } = thinkingProfile(model);
  return levels.length > 1 ? { levels, default: levels[startIndex(levels, start)]! } : undefined;
}

export class MainEffort {
  private raised = 0;

  private readonly preferred = new Map<string, ModelThinkingLevel>();

  constructor(private readonly record: (type: "effort_change", data: { from: ModelThinkingLevel; to: ModelThinkingLevel; signal: EffortSignal }) => void) {}

  /** 这次调用该用的档。 */
  level(model: Model<Api>): ModelThinkingLevel {
    const { levels, start } = thinkingProfile(model);

    return levels[Math.min(startIndex(levels, this.preferred.get(`${model.provider}/${model.id}`) ?? start) + this.raised, levels.length - 1)]!;
  }

  base(model: Model<Api>): ModelThinkingLevel {
    const { levels, start } = thinkingProfile(model);
    return levels[startIndex(levels, this.preferred.get(`${model.provider}/${model.id}`) ?? start)]!;
  }

  /** 手动选择成为此模型的起始档；只重置正在使用该模型的自动加档。 */
  prefer(modelId: string, level: ModelThinkingLevel | null, current?: Model<Api>, restore = false): void {
    const unchanged = this.preferred.get(modelId) === (level ?? undefined);
    if (level === null) this.preferred.delete(modelId);
    else this.preferred.set(modelId, level);
    if (current && `${current.provider}/${current.id}` === modelId && !(restore && unchanged)) this.raised = 0;
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

/** 主任务在新任务上、未手动选择起始档时的档。阅读卡的深度档用它，不读这一路已经升过的档。 */
export function restingEffort(model: Model<Api>): ModelThinkingLevel {
  return new MainEffort(() => {}).level(model);
}
