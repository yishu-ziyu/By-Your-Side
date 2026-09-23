/**
 * 扩展侧剪贴板桥：经本机 HTTP 调用伴随进程里的 macOS NSPasteboard 宿主。
 * 语义对齐 ClipboardBridge（beginTemporary → changeCount；finish 并发则 changed 且不覆盖）。
 *
 * 宿主实现见 agent/src/clipboard-darwin.ts（对照 citrolabs/ego-lite@dca7003… MIT / CitroLabs）。
 * 本文件不触碰用户剪贴板正文，也不把正文写入日志。
 */

import type {
  ClipboardBridge,
  ClipboardFinishStatus,
  NormalizedPasteContent,
} from "../../../shared/pointer-input.js";

/**
 * 验收脚本可以在 globalThis 上覆盖剪贴板宿主地址
 * （见 scripts/acceptance/browser-capability-paste.mts 的 initScript）。
 * 用具名接口声明这个注入点：不再写 `declare const globalThis: typeof globalThis & …`，
 * 那种自指写法会让 globalThis 的类型环路回自身（TS2502）。
 */
interface ClipboardUrlGlobal {
  __SIDEAGENT_CLIPBOARD_URL__?: string;
}

/**
 * 没有覆盖时只连自己的伴随进程（hello_ok.clipboardPort）。不回退到固定端口：
 * 那个端口可能属于另一个浏览器或验收实例的伴随进程。
 */
function clipboardBaseUrl(hostPort: () => number | undefined): string {
  // SAFETY: 该覆盖点是验收脚本 initScript 注入的可选全局，读取方下一步按 typeof 判空；
  // 断言只把 globalThis 收窄成具名接口以断掉自指类型环，运行期读写的仍是 globalThis.__SIDEAGENT_CLIPBOARD_URL__。
  const override = (globalThis as ClipboardUrlGlobal).__SIDEAGENT_CLIPBOARD_URL__;

  if (typeof override === "string" && override.length > 0) return override.replace(/\/$/, "");
  const port = hostPort();

  if (port === undefined || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("伴随进程没有提供剪贴板服务（还没连上，或它的剪贴板服务没有启动），无法粘贴。");
  }

  return `http://127.0.0.1:${port}`;
}

async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const url = `${baseUrl}${path}`;
  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  } catch (error) {
    throw new Error(
      `剪贴板宿主不可达（${url}）：${error instanceof Error ? error.message : String(error)}。请确认伴随进程已启动 macOS clipboard HTTP 服务。`,
    );
  }

  const data = (await response.json()) as T & { ok?: boolean; error?: string };

  if (!response.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error(
      (data as { error?: string }).error || `clipboard host HTTP ${response.status}`,
    );
  }

  return data;
}

/**
 * 正式宿主桥：写入临时 text+html，按 changeCount 恢复或承认并发 changed。
 * hostPort 读当前连接的伴随进程在 hello_ok 里报的剪贴板端口。
 */
export function createDarwinClipboardBridge(hostPort: () => number | undefined): ClipboardBridge {
  return {
    async beginTemporary(content: NormalizedPasteContent): Promise<{ changeCount: number }> {
      const payload: NormalizedPasteContent = { text: content.text };

      if (content.html !== undefined) payload.html = content.html;
      const result = await postJson<{ changeCount: number }>(clipboardBaseUrl(hostPort), "/begin", payload);

      if (!Number.isFinite(result.changeCount)) {
        throw new Error("clipboard host did not return changeCount");
      }

      return { changeCount: result.changeCount };
    },
    async finish(expectedChangeCount: number): Promise<ClipboardFinishStatus> {
      const result = await postJson<{ status: ClipboardFinishStatus }>(clipboardBaseUrl(hostPort), "/finish", {
        expectedChangeCount,
      });

      if (result.status !== "restored" && result.status !== "changed") {
        throw new Error(`clipboard host returned unexpected status`);
      }

      return result.status;
    },
  };
}

export function isDarwinClipboardHostPlatform(): boolean {
  return typeof navigator !== "undefined" && /mac|iphone|ipad|ipod/i.test(navigator.platform ?? "");
}
