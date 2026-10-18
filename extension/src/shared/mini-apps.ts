/** 回答里的小程序（实验功能，docs/evals/20261019-mini-apps.md）：设置页的开关，默认关。 */
export const MINI_APPS_KEY = "sideagent_mini_apps";

export const isMiniAppsOn = (value: unknown): boolean => value === true;
