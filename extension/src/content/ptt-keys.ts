/**
 * 按住说话的按键判定（#125，docs/evals/20261007-ptt-dictation.md R1）：只认右 ⌥。
 * 单独按住超过 PTT_HOLD_MS 才开始；中间按了别的键说明 ⌥ 在当修饰键用，不开始或取消；Esc、失焦取消。
 * 只管判定，不碰 DOM，录音与发送由调用方接。
 */

/** 按住多久才算开始说话：短于它的是轻点或组合键的开头。 */
export const PTT_HOLD_MS = 150;

export interface PttKeyEvent { type: "keydown" | "keyup"; code: string; repeat: boolean }

export interface PttKeyHandlers { onStart: () => void; onStop: () => void; onCancel: () => void }

export interface PttKeys {
  /** 交给它每个按键事件；返回 true 表示这一下属于按住说话（调用方可阻止默认行为）。 */
  handle: (event: PttKeyEvent) => boolean;
  /** 窗口失焦、页面隐藏：录音中则取消。 */
  reset: () => void;
}

const KEY = "AltRight";

export function createPttKeys(handlers: PttKeyHandlers): PttKeys {
  let state: "idle" | "armed" | "recording" | "spent" = "idle";
  let timer: ReturnType<typeof setTimeout> | undefined;

  const disarm = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  const cancel = () => {
    disarm();

    if (state === "recording") handlers.onCancel();
    // 取消后到松开右 ⌥ 之前，这一次按住都不再算。
    state = state === "idle" ? "idle" : "spent";
  };

  return {
    handle(event) {
      if (event.code === KEY) {
        if (event.type === "keydown") {
          if (event.repeat || state !== "idle") return state === "recording";
          state = "armed";
          timer = setTimeout(() => {
            timer = undefined;
            state = "recording";
            handlers.onStart();
          }, PTT_HOLD_MS);

          return false;
        }

        const was = state;
        disarm();
        state = "idle";

        if (was === "recording") handlers.onStop();

        return was === "recording";
      }

      if (event.type === "keydown" && (state === "armed" || state === "recording")) cancel();

      return false;
    },
    reset() {
      cancel();
      state = "idle";
    },
  };
}
