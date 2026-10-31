/**
 * 三图恢复实验的账本与档位核对。只观察请求，不改产品策略。
 *
 * 档位以该模型实际请求体为准，不看滑块下标，也不看芯片上的瞬时文字。
 * MiniMax-M3 走 anthropic-messages：产品把「关」写成不传 reasoning，线上是 thinking.type=disabled；
 * 低档是 thinking.type=enabled 且 budget_tokens 为该模型默认低档预算。字符串 "off" 反而会进另一套参数，不能当成关或低档。
 * xai/grok-4.5 走 openai-responses，请求里没有 thinking.type。低档是 reasoning.effort=low。
 * 它的 thinkingLevelMap.off 是 null；把 off 传进组包会被夹成 low，所以 --effort off 直接拒绝。
 * 不传手动档位时，产品从 medium 起算（agent/src/main-effort.ts）。这次对照要低档，必须写 --effort low。
 *
 * 复跑：
 *   npx tsx scripts/probes/image-recovery-run.mts --self-check --images <原图目录> --prior-trace <trace-relevant.json>
 *   npx tsx scripts/probes/image-recovery-run.mts --print-budget
 *   默认模型仍是 minimax-cn/MiniMax-M3。Grok 必须写 --model xai/grok-4.5 --effort low。
 *   SIDEAGENT_ACCEPTANCE_DIST=<固定扩展> npx tsx scripts/probes/image-recovery-run.mts --live --arm web|attachment --model xai/grok-4.5 --effort low --images <原图目录> --out <目录>
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { sanitizeTraceForStore } from "../../shared/trace-sanitize.ts";

/** 上一轮 6 次总请求里，标题和一次未完成的送图占掉了额度，第 6 张的完成回合被拦下。这里只给准备路径留出余量，不放到数十轮。 */
export const PROPOSED_BUDGET = {
  wallClockMs: 8 * 60 * 1000,
  maxMainRequests: 8,
  maxHttpAttempts: 14,
  preflightWallClockMs: 90_000,
  preflightHttpAttempts: 3,
} as const;

const AUX_PURPOSES = new Set([
  "task_title", "memory", "goal_check", "copy_intent", "reading_route", "interjection",
  "voice_plan", "voice_edit", "voice_free_reply", "voice_observation", "fact_check", "nudge",
]);

const SECRET_KEYS = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key)$/i;

export interface ThinkingWire {
  type: string;
  budget_tokens: number | null;
  display: string | null;
}

export interface ReasoningWire {
  effort: string | null;
  summary: string | null;
}

/** 预检要核对的请求字段。anthropic 用 thinking；其他协议用 reasoning。两者都没有时只核模型 id，并写明没有思考字段。 */
export interface EffortWire {
  modelRef: string;
  api: string;
  thinking: ThinkingWire | null;
  reasoning: ReasoningWire | null;
  note: string | null;
}

export const NO_THINKING_WIRE = "no thinking wire; product default effort";

/** Grok 4.5 这次对照用的模型与档位。低档在目录里是真实的 low；off 不是。 */
export const GROK_LIVE = { model: "xai/grok-4.5", effort: "low" } as const;

export interface ImageFact {
  sha256: string;
  bytes: number;
  declaredMime: string | null;
  detectedMime: string;
  width: number | null;
  height: number | null;
  matchesOriginalPage: number | null;
}

export type AttemptKind = "main" | "auxiliary" | "hedge" | "retry" | "preflight";
export type StopClass = "ok" | "provider_unavailable" | "connection" | "experiment_budget" | "http_rejected";

export interface HttpAttempt {
  n: number;
  atMs: number;
  phase: "preflight" | "task";
  kind: AttemptKind;
  purpose: string | null;
  model: string | null;
  maxTokens: number | null;
  thinking: ThinkingWire | null;
  reasoning: ReasoningWire | null;
  tierMatches: boolean | null;
  images: ImageFact[];
  responseStatus: number | null;
  stopClass: StopClass | null;
  blockedByController: boolean;
  note: string | null;
}

const ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function builtinModel(modelRef: string) {
  const slash = modelRef.indexOf("/");
  if (slash <= 0) throw new Error(`模型 id 需要写成服务商/模型，收到 ${modelRef}`);
  return getBuiltinModel(modelRef.slice(0, slash) as "xai", modelRef.slice(slash + 1) as "grok-4.5");
}

/** 与 main-effort.ts 相同：未登记起始档时用 medium，再取不高于它的最高一档。 */
export function restingLevel(levels: readonly string[]): string {
  const atOrBelow = levels.filter(level => ORDER.indexOf(level as typeof ORDER[number]) <= ORDER.indexOf("medium"));
  const index = atOrBelow.length ? levels.indexOf(atOrBelow.at(-1)!) : 0;
  return levels[index] ?? "off";
}

export function supportedLevels(modelRef: string): string[] {
  return [...getSupportedThinkingLevels(builtinModel(modelRef))];
}

/** 用 pi-ai 真正组包时的 onPayload 取字段，不手写预算表。apiKey 只用于本地组包，不返回、不落盘。 */
async function capturePayload(modelRef: string, reasoning: string | undefined): Promise<Record<string, unknown>> {
  const model = builtinModel(modelRef);
  const streamSimple = model.api === "anthropic-messages" ? streamAnthropic : model.api === "openai-responses" ? streamResponses : null;
  if (!streamSimple) return {};
  let captured: Record<string, unknown> | undefined;
  const stream = streamSimple(model as never, { messages: [{ role: "user", content: "tier-check", timestamp: 0 }] }, {
    ...(reasoning === undefined ? {} : { reasoning: reasoning as "low" }),
    apiKey: "local-tier-check",
    maxRetries: 0,
    onPayload: (payload: Record<string, unknown>) => {
      captured = payload;
      return payload;
    },
    fetch: async () => {
      throw new Error("tier-check-stop-before-network");
    },
  });
  await stream.result();
  return captured ?? {};
}

function assertSupported(modelRef: string, effort: string): void {
  const levels = supportedLevels(modelRef);
  if (levels.includes(effort)) return;
  throw new Error(`${modelRef} 没有档位 ${effort}。可用：${levels.join("、")}。不存在的档不会夹成 ${levels[0] ?? "默认"} 再放行。`);
}

/**
 * 该模型在这个档位上实际会放进请求体的字段。
 * anthropic-messages 仍用 thinking。其他协议不要求 thinking.type / budget_tokens。
 */
export async function expectedEffort(modelRef: string, effort: string): Promise<EffortWire> {
  assertSupported(modelRef, effort);
  const model = builtinModel(modelRef);
  const reasoningArg = effort === "off" ? undefined : effort;
  if (model.api !== "anthropic-messages" && model.api !== "openai-responses") {
    return { modelRef, api: model.api, thinking: null, reasoning: null, note: NO_THINKING_WIRE };
  }
  const payload = await capturePayload(modelRef, reasoningArg);
  const thinking = model.api === "anthropic-messages" ? normalizeThinking(payload.thinking) : null;
  const reasoning = model.api === "openai-responses" ? normalizeReasoning(payload.reasoning) : null;
  return {
    modelRef,
    api: model.api,
    thinking,
    reasoning,
    note: thinking || reasoning ? null : NO_THINKING_WIRE,
  };
}

/** MiniMax 路径：只要 anthropic thinking。产品的「关」是不传 reasoning，不是字符串 "off"。 */
export async function captureProviderThinking(modelRef: string, reasoning: string | undefined): Promise<{ thinking: ThinkingWire; max_tokens: number | null }> {
  const model = builtinModel(modelRef);
  if (model.api !== "anthropic-messages") {
    const effort = await expectedEffort(modelRef, reasoning ?? "off");
    throw new Error(`${modelRef} 的协议是 ${model.api}，没有 thinking.type。${effort.note ?? `reasoning=${JSON.stringify(effort.reasoning)}`}`);
  }
  const payload = await capturePayload(modelRef, reasoning);
  const thinking = normalizeThinking(payload.thinking);
  if (!thinking) throw new Error(`${modelRef} 在 reasoning=${reasoning ?? "省略"} 时没有组出 thinking`);
  return { thinking, max_tokens: typeof payload.max_tokens === "number" ? payload.max_tokens : null };
}

export async function expectedThinking(modelRef: string, effort: string): Promise<ThinkingWire> {
  const reasoning = effort === "off" ? undefined : effort;
  return (await captureProviderThinking(modelRef, reasoning)).thinking;
}

/** 监听该模型目录里的接口主机。MiniMax 仍同时看 minimaxi.com 与 minimax.io。 */
export function providerRequestPatterns(modelRef: string): Array<{ urlPattern: string; requestStage: "Request" | "Response" }> {
  const model = builtinModel(modelRef);
  const hosts = new Set<string>([new URL(model.baseUrl).host]);
  if (model.provider === "minimax-cn" || model.provider === "minimax") {
    hosts.add("api.minimaxi.com");
    hosts.add("api.minimax.io");
  }
  return [...hosts].flatMap(host => (["Request", "Response"] as const).map(requestStage => ({ urlPattern: `*${host}*`, requestStage })));
}

export function normalizeThinking(value: unknown): ThinkingWire | null {
  if (!value || typeof value !== "object") return null;
  const thinking = value as { type?: unknown; budget_tokens?: unknown; display?: unknown };
  if (typeof thinking.type !== "string") return null;
  return {
    type: thinking.type,
    budget_tokens: typeof thinking.budget_tokens === "number" ? thinking.budget_tokens : null,
    display: typeof thinking.display === "string" ? thinking.display : null,
  };
}

export function normalizeReasoning(value: unknown): ReasoningWire | null {
  if (!value || typeof value !== "object") return null;
  const reasoning = value as { effort?: unknown; summary?: unknown };
  if (typeof reasoning.effort !== "string" && reasoning.effort !== undefined) return null;
  return {
    effort: typeof reasoning.effort === "string" ? reasoning.effort : null,
    summary: typeof reasoning.summary === "string" ? reasoning.summary : null,
  };
}

export function sameThinking(actual: ThinkingWire | null, expected: ThinkingWire): boolean {
  return !!actual && actual.type === expected.type && actual.budget_tokens === expected.budget_tokens && actual.display === expected.display;
}

export function modelIdMatches(actual: string | null | undefined, modelRef: string): boolean {
  if (!actual) return false;
  const id = modelRef.includes("/") ? modelRef.slice(modelRef.indexOf("/") + 1) : modelRef;
  return actual === modelRef || actual === id;
}

/** 先对模型 id。有 thinking 就对 thinking；否则对 reasoning。两者都没有时只要求模型 id，并保留 note。 */
export function effortMatches(actual: { model?: string | null; thinking?: unknown; reasoning?: unknown }, expected: EffortWire): boolean {
  if (!modelIdMatches(actual.model, expected.modelRef)) return false;
  if (expected.thinking) return sameThinking(normalizeThinking(actual.thinking), expected.thinking);
  if (expected.reasoning) {
    const got = normalizeReasoning(actual.reasoning);
    return !!got && got.effort === expected.reasoning.effort && got.summary === expected.reasoning.summary;
  }
  return expected.note === NO_THINKING_WIRE;
}

/**
 * 芯片文字和滑块下标不参与判定。正式任务开始前调用：模型或档位字段不符就不要发任务。
 */
export async function beginFormalTask(input: {
  wire: { model?: string | null; thinking?: unknown; reasoning?: unknown };
  chipText?: string;
  sliderIndex?: number;
  expected: EffortWire;
  start: () => Promise<void>;
}): Promise<"started" | "tier_mismatch"> {
  void input.chipText;
  void input.sliderIndex;
  if (!effortMatches(input.wire, input.expected)) return "tier_mismatch";
  await input.start();
  return "started";
}

export function sniffImage(bytes: Uint8Array): { mime: string; width: number | null; height: number | null } {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { mime: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length - 8) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1]!;
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { mime: "image/jpeg", width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
      }
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (i + 4 > bytes.length) break;
      const segment = (bytes[i + 2]! << 8) | bytes[i + 3]!;
      if (segment < 2) break;
      i += 2 + segment;
    }
    return { mime: "image/jpeg", width: null, height: null };
  }
  if (bytes.length >= 16 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    const tag = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
    if (tag === "VP8X" && bytes.length >= 30) {
      const width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
      const height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
      return { mime: "image/webp", width, height };
    }
    if (tag === "VP8 ") {
      const start = findBytes(bytes, [0x9d, 0x01, 0x2a]);
      if (start >= 0 && start + 7 <= bytes.length) {
        const width = (bytes[start + 3]! | (bytes[start + 4]! << 8)) & 0x3fff;
        const height = (bytes[start + 5]! | (bytes[start + 6]! << 8)) & 0x3fff;
        return { mime: "image/webp", width, height };
      }
    }
    if (tag === "VP8L" && bytes.length >= 25) {
      const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
      return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { mime: "image/webp", width: null, height: null };
  }
  return { mime: "application/octet-stream", width: null, height: null };
}

function findBytes(bytes: Uint8Array, needle: number[]): number {
  for (let i = 0; i <= bytes.length - needle.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) if (bytes[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function imageFact(bytes: Uint8Array, declaredMime: string | null, originals: ReadonlyMap<string, number>): ImageFact {
  const sniffed = sniffImage(bytes);
  const digest = sha256(bytes);
  return {
    sha256: digest,
    bytes: bytes.length,
    declaredMime,
    detectedMime: sniffed.mime,
    width: sniffed.width,
    height: sniffed.height,
    matchesOriginalPage: originals.get(digest) ?? null,
  };
}

/** 从已解析的请求体里取出图片字节。不保留 base64。 */
export function imagesInPayload(value: unknown, originals: ReadonlyMap<string, number>, seen = new Set<unknown>()): ImageFact[] {
  if (!value || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const facts: ImageFact[] = [];
  const record = value as Record<string, unknown>;
  const encoded = encodedImage(record);
  if (encoded) {
    const bytes = decodeBase64(encoded.data);
    if (bytes) facts.push(imageFact(bytes, encoded.mime, originals));
  }
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) for (const item of child) facts.push(...imagesInPayload(item, originals, seen));
    else facts.push(...imagesInPayload(child, originals, seen));
  }
  return facts;
}

function encodedImage(record: Record<string, unknown>): { mime: string | null; data: string } | null {
  if (record.type === "image" && record.source && typeof record.source === "object") {
    const source = record.source as { media_type?: unknown; data?: unknown };
    if (typeof source.data === "string") return { mime: typeof source.media_type === "string" ? source.media_type : null, data: source.data };
  }
  if (record.type === "image" && typeof record.data === "string") {
    return { mime: typeof record.mimeType === "string" ? record.mimeType : null, data: record.data };
  }
  if (record.type === "image_url") {
    const url = typeof record.image_url === "string" ? record.image_url : (record.image_url as { url?: unknown } | undefined)?.url;
    if (typeof url === "string") {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
      if (match?.[2]) return { mime: match[1] ?? null, data: match[2] };
    }
  }
  return null;
}

function decodeBase64(data: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(data, "base64"));
  } catch {
    return null;
  }
}

export function attemptKind(input: { purpose?: string | null; maxTokens: number | null; imageCount: number; hedge: boolean; retry: boolean; phase: "preflight" | "task" }): AttemptKind {
  if (input.retry) return "retry";
  if (input.hedge) return "hedge";
  if (input.purpose && AUX_PURPOSES.has(input.purpose)) return "auxiliary";
  // 标题、记忆、核对的输出上限远低于主循环的模型窗口。预检里也先把它们摘出去，避免用标题请求的 thinking 判定主档。
  if (input.imageCount === 0 && input.maxTokens !== null && input.maxTokens < 10_000) return "auxiliary";
  if (input.phase === "preflight") return "preflight";
  return "main";
}

/**
 * 实验控制器拦截之后出现的连接失败，记为实验额度，不能记成产品连不上。
 * 529 等服务端状态在控制器动手之前仍是服务不可用。
 */
export function classifyStop(input: { blockedByController: boolean; controllerActive: boolean; status: number | null; errorText?: string | null }): StopClass {
  if (input.blockedByController) return "experiment_budget";
  const text = input.errorText ?? "";
  const connection = input.status === null || input.status === 0 || /connection error|failed to fetch|network error|aborted|econn|socket/i.test(text);
  if (input.controllerActive && connection) return "experiment_budget";
  if (input.status !== null && input.status >= 200 && input.status < 300) return "ok";
  if (input.status === 429 || (input.status !== null && input.status >= 500)) return "provider_unavailable";
  if (input.status !== null && input.status >= 400) return "http_rejected";
  return "connection";
}

export function overBudget(input: { elapsedMs: number; mainRequests: number; httpAttempts: number }): "time" | "main" | "http" | null {
  if (input.elapsedMs >= PROPOSED_BUDGET.wallClockMs) return "time";
  if (input.mainRequests >= PROPOSED_BUDGET.maxMainRequests) return "main";
  if (input.httpAttempts >= PROPOSED_BUDGET.maxHttpAttempts) return "http";
  return null;
}

export interface TraceEvent { type?: string; data?: Record<string, unknown> }

/** 一次 model_request 若在下一次 model_request 之前没有带用量的 turn_end，就算这次没有完成送达。 */
export function pairModelRequests(events: readonly TraceEvent[]): Array<{ effort: string | null; images: Array<{ sha256?: string; mimeType?: string; bytes?: number }>; completed: boolean; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null }> {
  const paired = [];
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]?.type !== "model_request") continue;
    const data = events[i]?.data ?? {};
    let usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null = null;
    for (let j = i + 1; j < events.length; j += 1) {
      if (events[j]?.type === "model_request") break;
      if (events[j]?.type === "turn_end") {
        const raw = events[j]?.data?.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined;
        usage = { input: raw?.input ?? 0, output: raw?.output ?? 0, cacheRead: raw?.cacheRead ?? 0, cacheWrite: raw?.cacheWrite ?? 0 };
        break;
      }
    }
    const completed = !!usage && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
    paired.push({
      effort: typeof data.effort === "string" ? data.effort : null,
      images: Array.isArray(data.images) ? data.images as Array<{ sha256?: string; mimeType?: string; bytes?: number }> : [],
      completed,
      usage,
    });
  }
  return paired;
}

export function sideCalls(events: readonly TraceEvent[]): Array<{ purpose: string; effort: string | null; outcome: string | null; reason: string | null; detail: string | null }> {
  return events.flatMap(event => {
    if (event.type !== "side_call") return [];
    const data = event.data ?? {};
    return [{
      purpose: typeof data.purpose === "string" ? data.purpose : "unknown",
      effort: typeof data.effort === "string" ? data.effort : null,
      outcome: typeof data.outcome === "string" ? data.outcome : null,
      reason: typeof data.reason === "string" ? data.reason : null,
      detail: typeof data.detail === "string" ? data.detail : null,
    }];
  });
}

/** 未完成的主请求后面紧跟着的「Connection error」不能单独当成产品断线。 */
export function contaminatedConnection(events: readonly TraceEvent[]): boolean {
  const paired = pairModelRequests(events);
  const last = paired.at(-1);
  if (!last || last.completed) return false;
  return sideCalls(events).some(call => call.outcome === "failed" && /connection/i.test(`${call.reason ?? ""} ${call.detail ?? ""}`));
}

export function coverPositions(pages: readonly number[] = [3, 6]): Array<{ page: number; row: number; col: number; artist: null; title: null; visibleText: null; status: "unscored" }> {
  const cells = [];
  for (const page of pages) for (const row of [1, 2, 3]) for (const col of [1, 2, 3]) cells.push({ page, row, col, artist: null, title: null, visibleText: null, status: "unscored" as const });
  return cells;
}

const SHARED_TASK = [
  "继续图集任务的中间步骤：完整理解图片，整理供下一步 Spotify 查证使用的封面候选清单。",
  "本轮只处理第1、3、6张。已核实的恢复记录：第1张已经看完，是人物照片，不含专辑封面，保留这个结果，不要重开、重截或重新识别。",
  "第3张曾被下载，但没有实际送入模型，尚未理解。第6张已经看过，是九宫格，只留下零散线索，九个封面尚未逐项整理。",
  "请实际补读未完成的图片。清单每一行写明：原图页码、九宫格行（1到3）、九宫格列（1到3）、可由原图核对的画面特征、实际读到的文字（不确定就标明）、有依据才写的艺人或专辑候选、当前状态（已送达、待补读、待查证或无法确认）。",
  "第3张和第6张合计 18 个位置都要有一行。无法确定的明确标出，不要把猜测写成已确认。最后单列未解决项。",
  "本轮不要下载或保存图片文件，不做 Spotify 搜索，不打开画布。",
].join("");

export function taskPrompt(arm: "web" | "attachment"): string {
  const channel = arm === "web"
    ? "当前页有原图入口，请从这些页面取得第3张和第6张。"
    : "第3张和第6张的原图已经作为本会话附件附上，请直接读取附件中的原图像素。不要打开网页取图，不要把第1张重新附上。";
  return `${SHARED_TASK}${channel}`;
}

const ANSWER_LEAKS = ["open.spotify.com/album", "2t713kWWEW8TxjAjGvV8qF", "my dead girlfriend", "死んだ僕", "yubiori", "under a cloud", "linkco.re"];

export function leakedAnswers(text: string): string[] {
  const lower = text.toLowerCase();
  return ANSWER_LEAKS.filter(token => lower.includes(token.toLowerCase()));
}

function dropSecretKeys(value: unknown, seen = new Set<unknown>()): unknown {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => dropSecretKeys(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.test(key)) continue;
    if ((key === "data" || key === "image") && typeof child === "string" && child.length > 24) {
      out[key] = "[image omitted]";
      continue;
    }
    out[key] = dropSecretKeys(child, seen);
  }
  return out;
}

export function scrubLedger(value: unknown): unknown {
  return sanitizeTraceForStore(dropSecretKeys(value));
}

export class RecoveryLedger {
  readonly startedAt = new Date().toISOString();
  stopReason: string | null = null;
  taskStarted = false;
  uiError: string | null = null;
  error: string | null = null;
  partialAnswer: string[] = [];
  attempts: HttpAttempt[] = [];
  downloads: string[] = [];
  reads: unknown[] = [];
  notes: string[] = [];
  preflight: unknown = null;
  originals: unknown[] = [];

  snapshot(): Record<string, unknown> {
    return {
      startedAt: this.startedAt,
      stopReason: this.stopReason,
      taskStarted: this.taskStarted,
      uiError: this.uiError,
      error: this.error,
      partialAnswer: this.partialAnswer,
      attempts: this.attempts,
      downloads: this.downloads,
      reads: this.reads,
      notes: this.notes,
      preflight: this.preflight,
      originals: this.originals,
      budget: PROPOSED_BUDGET,
    };
  }

  async save(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "result.json"), `${JSON.stringify(scrubLedger(this.snapshot()), null, 2)}\n`);
  }
}

export async function selfCheck(input: { images: string; priorTrace: string }): Promise<string[]> {
  const failures: string[] = [];
  const check = (name: string, pass: boolean, actual?: unknown) => {
    console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : ` ${JSON.stringify(actual)}`}`);
    if (!pass) failures.push(name);
  };

  check("预算没有放到数十轮", PROPOSED_BUDGET.maxMainRequests <= 10 && PROPOSED_BUDGET.maxHttpAttempts <= 16 && PROPOSED_BUDGET.wallClockMs <= 10 * 60 * 1000, PROPOSED_BUDGET);

  const low = await expectedThinking("minimax-cn/MiniMax-M3", "low");
  const off = await expectedThinking("minimax-cn/MiniMax-M3", "off");
  const offString = (await captureProviderThinking("minimax-cn/MiniMax-M3", "off")).thinking;
  check("低档线上参数是 enabled 且带预算", low.type === "enabled" && low.budget_tokens === 2048 && low.display === "summarized", low);
  check("产品的关档是 thinking disabled", off.type === "disabled" && off.budget_tokens === null, off);
  check("字符串 off 既不是关档也不是低档", !sameThinking(offString, off) && !sameThinking(offString, low), offString);
  check("上一轮 disabled 请求不能当成低档", !sameThinking({ type: "disabled", budget_tokens: null, display: null }, low));

  const miniExpected = await expectedEffort("minimax-cn/MiniMax-M3", "low");
  check("MiniMax 期望仍只看 thinking，不发明别的字段", sameThinking(miniExpected.thinking, low) && miniExpected.reasoning === null && miniExpected.note === null, miniExpected);
  let started = false;
  const gate = await beginFormalTask({
    wire: { model: "MiniMax-M3", thinking: { type: "disabled" } },
    chipText: "MiniMax-M3\n·\n中",
    sliderIndex: 0,
    expected: miniExpected,
    start: async () => { started = true; },
  });
  check("档位不符时正式任务不会开始", gate === "tier_mismatch" && !started, { gate, started });
  const passGate = await beginFormalTask({ wire: { model: "MiniMax-M3", thinking: low }, chipText: "随便", sliderIndex: 99, expected: miniExpected, start: async () => { started = true; } });
  check("线上参数相符才开始任务，不看芯片和滑块", passGate === "started" && started);
  const wrongModel = await beginFormalTask({ wire: { model: "grok-4.5", thinking: low }, expected: miniExpected, start: async () => { started = false; } });
  check("模型 id 不符不开始任务", wrongModel === "tier_mismatch" && started);

  const pages = [1, 3, 6] as const;
  const originals = new Map<string, number>();
  const loaded = [];
  for (const page of pages) {
    const bytes = new Uint8Array(await readFile(join(input.images, `cover_${page}.jpg`)));
    const fact = imageFact(bytes, null, originals);
    originals.set(fact.sha256, page);
    loaded.push({ page, ...fact, matchesOriginalPage: page });
  }
  check("第1张扩展名是 jpg、实际是 webp", loaded[0]?.detectedMime === "image/webp" && loaded[0].width === 1080, loaded[0]);
  check("第3张是 2160 jpeg", loaded[1]?.detectedMime === "image/jpeg" && loaded[1].width === 2160 && loaded[1].height === 2160, loaded[1]);
  check("第6张扩展名是 jpg、实际是 2160 webp", loaded[2]?.detectedMime === "image/webp" && loaded[2].width === 2160 && loaded[2].height === 2160, loaded[2]);

  const trace = JSON.parse(await readFile(input.priorTrace, "utf8")) as TraceEvent[];
  const paired = pairModelRequests(trace);
  const completedWithImages = paired.filter(item => item.completed && item.images.length > 0);
  const preparedNotCompleted = paired.filter(item => !item.completed && item.images.length > 0);
  check("上一轮主请求档位全是 off", paired.every(item => item.effort === "off"), paired.map(item => item.effort));
  check("完成送达的带图请求只有一张图", completedWithImages.length === 1 && completedWithImages[0]?.images.length === 1, completedWithImages);
  check("两张图的那次请求没有完成用量", preparedNotCompleted.length === 1 && preparedNotCompleted[0]?.images.length === 2, preparedNotCompleted);
  check("截图像素哈希对不上第3、6张原图", completedWithImages.every(item => item.images.every(image => !originals.has(String(image.sha256)))) && preparedNotCompleted.every(item => item.images.every(image => !originals.has(String(image.sha256)))));
  const calls = sideCalls(trace);
  check("标题和记忆调用与主请求分开", calls.some(call => call.purpose === "task_title") && calls.some(call => call.purpose === "memory"), calls);
  check("额度拦截后的 Connection error 不记成独立断线", contaminatedConnection(trace));

  const tiny = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);
  const payload = { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: tiny.toString("base64") } }] }], authorization: "Bearer super-secret-token" };
  const facts = imagesInPayload(payload, new Map());
  const scrubbed = JSON.stringify(scrubLedger({ payload, attempts: [{ headers: { authorization: "Bearer super-secret-token", cookie: "session=abc" }, body: "Bearer super-secret-token" }] }));
  check("请求体里的图片按字节哈希保存", facts.length === 1 && facts[0]?.sha256 === sha256(tiny) && facts[0].declaredMime === "image/jpeg");
  check("落盘不含密钥和图片 base64", !scrubbed.includes("super-secret-token") && !scrubbed.includes(tiny.toString("base64")) && !scrubbed.includes("session=abc"));

  const ledger = new RecoveryLedger();
  const dir = join(input.images, "../.ledger-self-check");
  try {
    throw new Error("页面脚本出错：SyntaxError: Invalid or unexpected token");
  } catch (error) {
    ledger.uiError = String(error);
    ledger.stopReason = "ui_scrape_failed";
    ledger.attempts.push({
      n: 1, atMs: 0, phase: "task", kind: "main", purpose: null, model: "MiniMax-M3", maxTokens: 512000,
      thinking: off, reasoning: null, tierMatches: false, images: [], responseStatus: 529, stopClass: classifyStop({ blockedByController: false, controllerActive: false, status: 529 }),
      blockedByController: false, note: null,
    });
  } finally {
    await ledger.save(dir);
  }
  const saved = JSON.parse(await readFile(join(dir, "result.json"), "utf8")) as { uiError: string; stopReason: string; attempts: Array<{ stopClass: string }> };
  check("界面提取失败后 finally 仍写入结果", saved.uiError.includes("SyntaxError") && saved.stopReason === "ui_scrape_failed");
  check("529 记为服务不可用，控制器拦截记为实验额度", saved.attempts[0]?.stopClass === "provider_unavailable" && classifyStop({ blockedByController: true, controllerActive: true, status: null, errorText: "Connection error." }) === "experiment_budget");

  const cells = coverPositions();
  check("18 个位置待核对且没有预填专辑答案", cells.length === 18 && cells.every(cell => cell.artist === null && cell.title === null && cell.status === "unscored") && new Set(cells.map(cell => cell.page)).size === 2);
  check("两个条件的提示词都不含已知专辑答案", leakedAnswers(taskPrompt("web")).length === 0 && leakedAnswers(taskPrompt("attachment")).length === 0, leakedAnswers(`${taskPrompt("web")}\n${taskPrompt("attachment")}`));
  check("网页条件和附件条件只有取图入口不同", taskPrompt("web") !== taskPrompt("attachment") && taskPrompt("web").includes("原图入口") && taskPrompt("attachment").includes("附件"));
  check("主请求、辅助、重试、对冲分开记", attemptKind({ purpose: "task_title", maxTokens: 200, imageCount: 0, hedge: false, retry: false, phase: "task" }) === "auxiliary"
    && attemptKind({ purpose: null, maxTokens: 512000, imageCount: 1, hedge: false, retry: false, phase: "task" }) === "main"
    && attemptKind({ purpose: null, maxTokens: 512000, imageCount: 0, hedge: true, retry: false, phase: "task" }) === "hedge"
    && attemptKind({ purpose: null, maxTokens: 512000, imageCount: 0, hedge: false, retry: true, phase: "task" }) === "retry"
    && attemptKind({ purpose: null, maxTokens: 200, imageCount: 0, hedge: false, retry: false, phase: "preflight" }) === "auxiliary"
    && attemptKind({ purpose: null, maxTokens: 512000, imageCount: 0, hedge: false, retry: false, phase: "preflight" }) === "preflight");

  const effortSource = await readFile(new URL("../../agent/src/main-effort.ts", import.meta.url), "utf8");
  const grokLevels = supportedLevels(GROK_LIVE.model);
  check("产品未选手动档时仍从 medium 起算", /const START: ModelThinkingLevel = "medium"/.test(effortSource));
  check("Grok 4.5 可用 low、medium、high，没有 off", grokLevels.join(",") === "low,medium,high", grokLevels);
  check("因此 Grok 不选手动档时是 medium", restingLevel(grokLevels) === "medium");
  let grokOff = "";
  try {
    await expectedEffort(GROK_LIVE.model, "off");
  } catch (error) {
    grokOff = String(error);
  }
  check("Grok 拒绝 --effort off，避免被夹成 low", grokOff.includes("没有档位 off"), grokOff);
  const grokLow = await expectedEffort(GROK_LIVE.model, GROK_LIVE.effort);
  check("Grok 低档没有 thinking.type，线上是 reasoning.effort=low", grokLow.thinking === null && grokLow.reasoning?.effort === "low" && grokLow.reasoning.summary === "auto" && grokLow.note === null, grokLow);
  const grokPatterns = providerRequestPatterns(GROK_LIVE.model).map(item => item.urlPattern);
  const miniPatterns = providerRequestPatterns("minimax-cn/MiniMax-M3").map(item => item.urlPattern);
  check("Grok 预检监听 api.x.ai，不套 MiniMax 主机", grokPatterns.some(item => item.includes("api.x.ai")) && !grokPatterns.some(item => item.includes("minimaxi.com")), grokPatterns);
  check("MiniMax 预检仍监听 minimaxi.com", miniPatterns.some(item => item.includes("minimaxi.com")));
  let grokStarted = false;
  const grokGate = await beginFormalTask({
    wire: { model: "grok-4.5", reasoning: { effort: "low", summary: "auto" } },
    chipText: "Grok 4.5 · 低",
    sliderIndex: 0,
    expected: grokLow,
    start: async () => { grokStarted = true; },
  });
  check("Grok 预检对上模型 id 和 reasoning.effort 才开始", grokGate === "started" && grokStarted);
  const grokWrong = await beginFormalTask({
    wire: { model: "grok-4.5", thinking: { type: "enabled", budget_tokens: 2048, display: "summarized" } },
    expected: grokLow,
    start: async () => { grokStarted = false; },
  });
  check("只带 MiniMax thinking、没有 reasoning.effort 时 Grok 不开始", grokWrong === "tier_mismatch" && grokStarted);
  const grokOtherModel = await beginFormalTask({
    wire: { model: "MiniMax-M3", reasoning: { effort: "low", summary: "auto" } },
    expected: grokLow,
    start: async () => undefined,
  });
  check("Grok 预检模型 id 不符不开始", grokOtherModel === "tier_mismatch");
  const bare = { modelRef: "example/plain", api: "other", thinking: null, reasoning: null, note: NO_THINKING_WIRE } as const;
  check("没有思考字段时只核模型 id，并注明产品默认", effortMatches({ model: "plain" }, bare) && !effortMatches({ model: "other" }, bare) && bare.note === NO_THINKING_WIRE);

  return failures;
}
