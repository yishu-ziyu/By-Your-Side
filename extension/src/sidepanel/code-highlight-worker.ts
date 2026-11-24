import { highlightCodeTokens } from "../../../shared/code-highlight.js";

interface HighlightRequest {
  id: number;
  key: string;
  code: string;
  lang: string;
}

self.onmessage = (event: MessageEvent<HighlightRequest>) => {
  const { id, key, code, lang } = event.data;

  self.postMessage({ id, key, code, lang, html: highlightCodeTokens(code, lang) });
};
