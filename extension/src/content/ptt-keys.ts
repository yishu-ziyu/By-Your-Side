const PTT_HOLD_MS = 150;

interface PttKeyEvent { type: "keydown" | "keyup"; code: string; repeat: boolean }

interface PttKeyHandlers { onStart: () => void; onStop: () => void; onCancel: () => void }

interface PttKeys {
  handle: (event: PttKeyEvent) => boolean;
  reset: () => void;
}

export function createPttKeys(handlers: PttKeyHandlers, key: () => string): PttKeys {
  let state: "idle" | "armed" | "recording" | "spent" = "idle";
  let timer: ReturnType<typeof setTimeout> | undefined;

  const disarm = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  const cancel = () => {
    disarm();

    if (state === "recording") handlers.onCancel();
    state = state === "idle" ? "idle" : "spent";
  };

  return {
    handle(event) {
      if (event.code === key()) {
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
