/** 扩展内构建替换 `ws`：语音连接一律经 connect 注入浏览器 WebSocket，这里只提供 OPEN 常量。 */
export default class WebSocket {
  static readonly OPEN = 1;

  constructor() {
    throw new Error("扩展里不能直接创建 ws 连接，请经 connect 注入");
  }
}
