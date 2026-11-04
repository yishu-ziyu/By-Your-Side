const unavailable = (): never => {
  throw new Error("扩展里没有本机文件");
};

const unavailableAsync = async (): Promise<never> => unavailable();

export const constants = { O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128 };

export const existsSync = (): boolean => false;

export const appendFileSync = unavailable;

export const closeSync = unavailable;

export const copyFileSync = unavailable;

export const fsyncSync = unavailable;

export const mkdirSync = unavailable;

export const openSync = unavailable;

export const readFileSync = unavailable;

export const readdirSync = unavailable;

export const realpathSync = unavailable;

export const renameSync = unavailable;

export const rmSync = unavailable;

export const statSync = unavailable;

export const unlinkSync = unavailable;

export const writeFileSync = unavailable;

export const access = unavailableAsync;

export const appendFile = unavailableAsync;

export const chmod = unavailableAsync;

export const mkdir = unavailableAsync;

export const open = unavailableAsync;

export const readFile = unavailableAsync;

export const readdir = unavailableAsync;

export const rename = unavailableAsync;

export const rm = unavailableAsync;

export const stat = unavailableAsync;

export const unlink = unavailableAsync;

export const writeFile = unavailableAsync;
