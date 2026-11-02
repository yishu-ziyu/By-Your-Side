import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

/** A browser-owned restriction will not change when the model retries a different read tool. */
export function restrictedPagePolicy(isRestrictedCall: (id: string) => boolean, onRestricted: () => void): ExtensionFactory {
  return pi => {
    pi.on('tool_result', (event, ctx) => {
      if (!event.isError || !['snapshot', 'screenshot', 'read_element', 'read_elements', 'js', 'browser_run'].includes(event.toolName)) return;
      if (!isRestrictedCall(event.toolCallId)) return;
      onRestricted();
      ctx.abort();
    });
  };
}
