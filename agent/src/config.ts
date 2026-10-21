
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 本机 node 脚本写诊断记录的根目录（扩展内 agent 不用它）。
 * 凭据文件不跟着走：StepFun 等密钥始终从 ~/.sideagent 原位只读。
 */
export function dataDir(): string {
  return process.env.SIDEAGENT_DATA_DIR?.trim() || join(homedir(), ".sideagent");
}

