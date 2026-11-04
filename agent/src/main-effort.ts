import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { thinkingProfile } from "../../shared/model-capabilities.js";

type EffortSignal = "tool_failures" | "no_progress" | "goal_unfinished" | "user_correction" | "new_task";

const START: ModelThinkingLevel = "medium";

const ORDER: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function startIndex(levels: readonly ModelThinkingLevel[], start: ModelThinkingLevel = START): number {
  const atOrBelow = levels.filter(level => ORDER.indexOf(level) <= ORDER.indexOf(start));

  return atOrBelow.length ? levels.indexOf(atOrBelow.at(-1)!) : 0;
}

export function thinkingChoice(model: Model<Api>): { levels: ModelThinkingLevel[]; default: ModelThinkingLevel } | undefined {
  const { levels, start } = thinkingProfile(model);
  return levels.length > 1 || levels[0] !== 'off' ? { levels, default: levels[startIndex(levels, start)]! } : undefined;
}

export class MainEffort {
  private raised = 0;

  private readonly preferred = new Map<string, ModelThinkingLevel>();

  constructor(private readonly record: (type: "effort_change", data: { from: ModelThinkingLevel; to: ModelThinkingLevel; signal: EffortSignal }) => void) {}

  level(model: Model<Api>): ModelThinkingLevel {
    const { levels, start } = thinkingProfile(model);

    return levels[Math.min(startIndex(levels, this.preferred.get(`${model.provider}/${model.id}`) ?? start) + this.raised, levels.length - 1)]!;
  }

  base(model: Model<Api>): ModelThinkingLevel {
    const { levels, start } = thinkingProfile(model);
    return levels[startIndex(levels, this.preferred.get(`${model.provider}/${model.id}`) ?? start)]!;
  }

  prefer(modelId: string, level: ModelThinkingLevel | null, current?: Model<Api>, restore = false): void {
    const unchanged = this.preferred.get(modelId) === (level ?? undefined);
    if (level === null) this.preferred.delete(modelId);
    else this.preferred.set(modelId, level);
    if (current && `${current.provider}/${current.id}` === modelId && !(restore && unchanged)) this.raised = 0;
  }

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

  reset(model: Model<Api> | undefined): void {
    if (!this.raised) return;
    const from = model ? this.level(model) : undefined;
    this.raised = 0;

    if (model && from !== this.level(model)) this.record("effort_change", { from: from!, to: this.level(model), signal: "new_task" });
  }
}

export function restingEffort(model: Model<Api>): ModelThinkingLevel {
  return new MainEffort(() => {}).level(model);
}
