/** 扩展内构建替换 `node:http`：Pi 1.0 的登录模块静态引入它做本机回调；浏览器里只用设备码登录，不起服务。 */
export const createServer = (): never => {
  throw new Error("浏览器里不能启动本机回调服务");
};
