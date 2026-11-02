const PERSONAL_STEP = /密码|口令|验证码|安全码|卡号|有效期|安全验证|身份验证|二次验证|付款|支付|银行卡|授权|password|passcode|captcha|verification|security code|card number|expir|\bcvv\b|\bcvc\b|two.factor|\b2fa\b|payment|authori[sz]/i;

/** A choice reply may resume only a handoff that asks for a choice, never a personal verification step. */
export function handoffChoices(ask: unknown, kind: unknown, options: unknown): string[] | null {
  if (kind !== 'choice' || typeof ask !== 'string' || !Array.isArray(options)) return null;
  if (PERSONAL_STEP.test(ask)) return null;
  const choices = options.filter((v): v is string => typeof v === 'string').map(v => v.trim());
  return choices.length >= 2 && choices.length <= 6 && choices.every(v => v.length >= 2 && v.length <= 50) && new Set(choices.map(v => v.toLowerCase())).size === choices.length ? choices : null;
}

function oneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + Number(i < a.length || j < b.length) <= 1;
}

/** Only a unique affirmative choice is enough to hand the page back. */
export function matchesHandoffChoice(text: string, choices: string[]): boolean {
  const input = text.trim().toLowerCase();
  if (!input || PERSONAL_STEP.test(input) || /不要|不用|不选|不是|除了|排除|别|取消|停止|暂停|等等|稍后|先不|\b(?:not|don't|do not|except|stop|wait|cancel)\b/i.test(input)) return false;
  const words = input.match(/[a-z0-9]+/g) ?? [];
  const hits = choices.filter(choice => {
    const label = choice.toLowerCase();
    if (input.includes(label)) return true;
    const distinctive = (label.match(/[a-z0-9]+/g) ?? []).filter(part => part.length >= 5 && choices.every(other => {
      const otherWords: string[] = other.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      return other === choice || !otherWords.includes(part);
    }));
    return distinctive.some(part => words.some(word => oneEdit(word, part)));
  });
  const ordinals = [...input.matchAll(/第\s*([一二三四五六1-6])\s*(?:个|种|项|选项)/g)].map(match => {
    const position = '一二三四五六'.indexOf(match[1]!);
    return position >= 0 ? position : Number(match[1]) - 1;
  });
  if (ordinals.length > 1 || ordinals.some(index => index >= choices.length)) return false;
  if (ordinals.length === 1) return hits.length === 0 || (hits.length === 1 && choices.indexOf(hits[0]!) === ordinals[0]);
  return hits.length === 1;
}
