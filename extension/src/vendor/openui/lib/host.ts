let nextCall = 0;
const calls = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();

addEventListener("message", (event) => {
  const reply = event.source === parent && event.data && event.data.miniAppReply;
  const call = reply && calls.get(reply);
  if (!call) return;
  calls.delete(reply);
  if (event.data.ok) call.resolve(event.data.value as never);
  else call.reject(new Error(event.data.error || "没有取到"));
});

/** Everything from outside the sandbox goes through the side panel, which decides what it may fetch. */
export function askHost<T>(op: string, arg: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++nextCall;
    calls.set(id, { resolve: resolve as (value: never) => void, reject });
    parent.postMessage({ miniApp: "net", id, op, arg }, "*");
  });
}
