import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

const terminatingDetails = new WeakSet<object>();
export function isRestrictedPageTermination(details: unknown): boolean {
  return !!details && typeof details === 'object' && terminatingDetails.has(details);
}

/** The first restriction leaves the agent free to navigate; only a repeat on that page stops the run. */
export class RestrictedPagePolicy {
  private readonly seen = new Set<string>();
  constructor(private readonly take: (id: string) => { tabId: number | null; url: string } | undefined, private readonly onRestricted: () => void) {}
  reset(): void { this.seen.clear(); }
  extension(): ExtensionFactory {
    return pi => {
      pi.on('tool_result', event => {
        if (!event.isError || !['snapshot', 'screenshot', 'read_element', 'read_elements', 'js', 'browser_run'].includes(event.toolName)) return;
        const page = this.take(event.toolCallId);
        if (!page) return;
        const key = JSON.stringify([page.tabId, page.url.split('#')[0]]);
        if (!this.seen.has(key)) { this.seen.add(key); return; }
        this.onRestricted();
        const details = { ...(event.details && typeof event.details === 'object' ? event.details : {}) };
        terminatingDetails.add(details);
        return { details };
      });
    };
  }
}
