// 前提：Runtime.evaluate 开启 throwOnSideEffect 后，返回对象的序列化也不会触发写入。
// 预期结果由服务器独立计数：POST 为 0 则前提成立，否则失败。
import { createServer } from "node:http";
import { chromium } from "playwright";

let posts = 0;

const server = createServer((req, res) => {
  if (req.method === "POST") posts++;
  res.setHeader("content-type", "text/html");
  res.end("<title>fixture</title><p>fixture</p>");
}).listen(0, "127.0.0.1");

await new Promise(r => server.once("listening", r));

// SAFETY: listen(0, host) on TCP always yields an AddressInfo once "listening" fired.
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.goto(url);
  // 页面先放好对象；脚本只读取它们，副作用只可能发生在返回值序列化时。
  // 用字符串传入，避免 tsx 给函数插入页面里不存在的 __name 辅助函数。
  await page.evaluate(`
    const post = () => fetch("/commit", { method: "POST" });
    window.getterObj = Object.defineProperty({}, "v", { enumerable: true, get() { post(); return 1; } });
    window.toJSONObj = { toJSON() { post(); return 1; } };
  `);
  const cdp = await page.context().newCDPSession(page);
  const cases = { plainRead: "document.title", getterPost: "window.getterObj", toJSONPost: "window.toJSONObj" };

  for (const [name, expression] of Object.entries(cases)) {
    const before = posts;

    const r = await cdp.send("Runtime.evaluate", { expression, throwOnSideEffect: true, returnByValue: true, timeout: 200 })
      .catch(e => ({ error: String(e) }));

    await page.waitForTimeout(300);
    console.log(name, JSON.stringify(r).slice(0, 120), "POST+", posts - before);
  }

  console.log(posts === 0 ? "PASS 前提成立：0 POST" : `FAIL 前提不成立：服务器收到 ${posts} 次 POST`);
  process.exitCode = posts === 0 ? 0 : 1;
} finally {
  await browser.close();
  server.close();
}
