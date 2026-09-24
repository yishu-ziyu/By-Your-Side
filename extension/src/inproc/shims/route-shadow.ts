/** 扩展内不记录本机 Jev 影子评测，但会话管理器仍调用这两个观察入口。 */
export const sharedRouteShadow = () => ({ observe() {}, actual() {} });
