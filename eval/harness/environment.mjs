/** Only browser/page evidence can exclude a result; the assistant's explanation is not evidence. */
export function siteBlock(page) {
  if (!page) return null;
  const { url = '', title = '', text = '', errorText = '', status = null, challenge = false } = page;
  let kind = null;

  if (/^net::ERR_(CONNECTION_(CLOSED|REFUSED|RESET|TIMED_OUT)|NAME_NOT_RESOLVED|TIMED_OUT|INTERNET_DISCONNECTED|EMPTY_RESPONSE)/.test(errorText)
      || (url.startsWith('chrome-error:') || /无法访问此网站|This site can.t be reached/i.test(title)) && /ERR_(CONNECTION|NAME_NOT_RESOLVED|TIMED_OUT|INTERNET_DISCONNECTED|EMPTY_RESPONSE)/.test(text)) kind = 'connection';
  else if (status === 429 || /^https?:\/\/news\.ycombinator\.com\//.test(url) && text.length < 3000 && /^Sorry(?:[.!\s]|$)/.test(text.trim())) kind = 'rate_limit';
  else if (challenge && /verify you are human|just a moment|人机验证|安全验证/i.test(title) && /verify|human|验证|checking/i.test(text)) kind = 'captcha';

  if (!kind) return null;

  return { kind, evidence: [{ url, title, status, errorText, text: text.slice(0, 1000), challenge }] };
}

export function environmentFailure(tr) {
  if (tr?.environment?.evidence?.length) return tr.environment;
  const observed = tr?.site_observations?.at(-1);

  return siteBlock(observed ?? (tr?.final_page ? { ...tr.final_page, text: tr.final_page_text ?? '' } : null));
}
