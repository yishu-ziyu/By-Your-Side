/**
 * 运行形态决定的工具可用性。只装扩展时没有本机伴随进程：没有本机文件（node:fs 垫片调用即报错）、
 * 没有剪贴板宿主、上传授权读不了本机路径，主会话也没有可交给助手的模型运行时（请人必然失败）。
 * 这些工具在扩展里不列给模型；Node 托管的检查循环照常提供。依据 docs/evals/20261001-data-to-file.md。
 */
import { dataDir } from "./config.js";

/** 扩展内构建把 `./config.js` 换成垫片，dataDir 返回空串；本机总有 ~/.sideagent 或 SIDEAGENT_DATA_DIR。 */
export function companionHostAvailable(): boolean {
  return dataDir() !== "";
}

/** 只在 Node 托管时才能工作的工具（模型可见名）：本机文件、上传、剪贴板，以及请助手。 */
export const COMPANION_ONLY_TOOLS = ["download_save_as", "upload_file", "file_chooser_set_files", "paste", "spawn_worker"] as const;

/** 当前运行形态里调用必然失败、因而不列给模型的工具。 */
export function runtimeUnavailableTools(): ReadonlySet<string> {
  return new Set<string>(companionHostAvailable() ? [] : COMPANION_ONLY_TOOLS);
}
