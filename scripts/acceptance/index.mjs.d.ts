export const UNIQUE_TEXT: string;
export const COUNTER_BEFORE: string;
export const COUNTER_AFTER: string;
export const FILL_BEFORE: string;
export const FILL_AFTER: string;
export const FILL_VALUE: string;
export const INC_BUTTON_LABEL: string;
export const PHASE_IDLE: string;
export const PHASE_CLICKED: string;
export const PHASE_CHANGED: string;
export const DEFAULT_RUNS: number;
export const FAILURE: Record<string, string>;

export function extensionIdFromKey(key: string): string;
export function fixturePath(): string;
export function loadFixtureHtml(): string;
export function recoveryChromeMain(): string;
export function recoveryExtension(extId: string): string;

export function parsePsLine(line: string): { pid: number; command: string } | null;
export function isBrowserMainProcess(command: string): boolean;
export function classifyBrowserCommand(
  command: string,
  dirs?: { chromeMainDir?: string; defaultChromeDir?: string },
): "chrome-main" | "default-chrome" | "foreign" | "other";
export function parseRemoteDebuggingPort(command: string): number | null;
export function parseLsofListenPids(lsofText: string): number[];
export function discoverChromeMain(io?: {
  exec?: (file: string, args?: string[]) => string;
  readFile?: (path: string, encoding?: string) => string;
  exists?: (path: string) => boolean;
  chromeMainDir?: string;
  defaultChromeDir?: string;
  wrapperApp?: string;
}): {
  wrapperBundleId: string;
  wrapperApp: string;
  pid: number;
  port: number;
  userDataDir: string;
  command: string;
  refusedDefaultChromePids: number[];
};

export function redactEvidence<T>(value: T, key?: string): T;
export function assertNoSecrets(value: unknown, path?: string): void;

export interface RunStep {
  name: string;
  ok: boolean;
  expected: unknown;
  actual: unknown;
  durationMs: number;
  failureCategory?: string;
}

export interface EvaluatedRun {
  ok: boolean;
  failureCategory: string | null;
  failureStage: string | null;
  steps: RunStep[];
  startedAt: number;
  elapsedMs: number;
}

export function classifyFailure(err: unknown, stage?: string): string;
export function containsNeedle(haystack: string, needle: string): boolean;
export function evaluateRun(driverResult: unknown, expected?: object): EvaluatedRun;
export function formatStep(step: RunStep): string;
export function formatRun(runIndex: number, evaluated: EvaluatedRun): string;
export function buildResultJson(payload: object): object;

export function findServiceWorker(
  targets: unknown,
  extensionId: string,
): { url?: string; type?: string; targetId?: string; id?: string } | undefined;

export function buildDriverExpression(opts: object): string;
export function swDriver(opts: object): Promise<unknown>;
export const USER_BLOCKED_ERROR: string;
export const LEAD_MARK: string;
export const WORKER_MARK: string;
export const USER_LEAD_MARK: string;
export const USER_WORKER_MARK: string;
export const TEAM_LEAD_SESSION: string;
export const TEAM_WORKER_SESSION: string;
export function buildTeamDriverExpression(opts: object): string;
export function teamDriver(opts: object): Promise<unknown>;
export function evaluateTeamRun(driverResult: unknown, expected?: object): EvaluatedRun;
export function formatTeamRun(runIndex: number, evaluated: EvaluatedRun): string;
