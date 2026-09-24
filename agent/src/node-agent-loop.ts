/**
 * 本机伴随进程专用：用 pi-coding-agent 的 AgentSession 作为会话循环。
 * 扩展里的构建把本文件换成 extension/src/inproc/shims/node-agent-loop.ts（调用即报错），
 * 那里的会话一律走 SessionCreateOptions.loop（pi-agent-core 循环）。
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerCliproxyProvider } from "./cliproxy.js";

export async function createNodeModelRuntime(): Promise<ModelRuntime> {
  const modelRuntime = await ModelRuntime.create();
  // 本地 CLIProxyAPI 池：key 运行时从 client.env 读取，端口不通时自动跳过，不影响启动
  await registerCliproxyProvider(modelRuntime);

  return modelRuntime;
}

export interface NodeLoopSpec {
  modelRuntime: ModelRuntime;
  customTools: ToolDefinition[];
  extensionFactories: { name: string; hidden: boolean; factory: ExtensionFactory }[];
  systemPrompt: string;
  appendPrompt: (base: string[]) => string[];
  sessionManager?: SessionManager;
  modelPattern?: string;
}

export async function createNodeLoop(spec: NodeLoopSpec): Promise<{ session: AgentSession; resourceLoader: DefaultResourceLoader }> {
  // steeringMode "all"：一次 drain 交付全部未读插话，用户连发的几条补充进同一轮模型输入；
  // pi 默认的 "one-at-a-time" 每条分别等到下一轮，实测让同一批补充被拆散到多次模型输入
  // （见 out/acceptance/continuous-steering-2026-09-15T15-32-14-585Z：最终值对但同轮交付为 false）。
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, steeringMode: "all" });

  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noContextFiles: true,
    extensionFactories: spec.extensionFactories,
    systemPromptOverride: () => spec.systemPrompt,
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    // 闭包读 mode ref；注意 SDK 只在 reload() 时求值并缓存（见 session.ts setMode 注释）
    appendSystemPromptOverride: (base) => spec.appendPrompt(base),
  });

  await resourceLoader.reload();

  const createOptions: CreateAgentSessionOptions = {
    modelRuntime: spec.modelRuntime,
    noTools: "builtin",
    customTools: spec.customTools,
    resourceLoader,
    sessionManager: spec.sessionManager ?? SessionManager.inMemory(process.cwd()),
    settingsManager,
  };

  if (spec.modelPattern) {
    const slash = spec.modelPattern.indexOf("/");

    const resolved = resolveCliModel({
      cliProvider: slash > 0 ? spec.modelPattern.slice(0, slash) : undefined,
      cliModel: slash > 0 ? spec.modelPattern.slice(slash + 1) : spec.modelPattern,
      modelRuntime: spec.modelRuntime,
    });

    if (resolved.error || !resolved.model) throw new Error(resolved.error ?? `模型不可用：${spec.modelPattern}`);

    if (resolved.warning) console.error(`[sideagent] ${resolved.warning}`);
    createOptions.model = resolved.model;

    if (resolved.thinkingLevel) createOptions.thinkingLevel = resolved.thinkingLevel;
  }

  const { session } = await createAgentSession(createOptions);

  return { session, resourceLoader };
}
