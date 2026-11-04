export default class WebSocket {
  static readonly OPEN = 1;

  constructor() {
    throw new Error("扩展里不能直接创建 ws 连接，请经 connect 注入");
  }
}
