const PERSONAL_STEP = /密码|口令|验证码|安全码|卡号|有效期|安全验证|身份验证|二次验证|付款|支付|银行卡|授权|password|passcode|captcha|verification|security code|card number|expir|\bcvv\b|\bcvc\b|two.factor|\b2fa\b|payment|authori[sz]/i;

export function handoffChoices(ask: unknown, kind: unknown, options: unknown): string[] | null {
  if (kind !== 'choice' || typeof ask !== 'string' || !Array.isArray(options)) return null;
  if (PERSONAL_STEP.test(ask)) return null;
  const choices = options.filter((v): v is string => typeof v === 'string').map(v => v.trim());
  return choices.length >= 2 && choices.length <= 6 && choices.every(v => v.length >= 2 && v.length <= 50) && new Set(choices.map(v => v.toLowerCase())).size === choices.length ? choices : null;
}

export const RESUME_UNCONFIRMED = "已保存，自动继续未确认";
