export const createServer = (): never => {
  throw new Error("浏览器里不能启动本机回调服务");
};
