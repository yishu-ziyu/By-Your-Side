/**
 * Agent 运行模式的模块级可变 ref（act = 直接操作；teach = 教学倾向增强）。
 * 由 main.ts 的 set_mode 帧写入；prompt 拼接与 page_event 注入判定读取。
 */
import type { AgentMode } from "../../shared/protocol.js";

let current: AgentMode = "act";

export function getMode(): AgentMode {
  return current;
}

export function setMode(mode: AgentMode): void {
  current = mode;
}
