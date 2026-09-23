/** 扩展内构建替换本机文件接口：扩展里没有本机文件，调用即报错（密钥等改由扩展存储提供）。 */
const unavailable = async (): Promise<never> => {
  throw new Error("扩展里没有本机文件");
};

export const readFile = unavailable;

export const stat = unavailable;

export const homedir = () => "";

export const join = (...parts: string[]) => parts.join("/");
