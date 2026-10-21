/** Fixed, read-only element properties. No model-supplied code or getters. */
export const ELEMENT_PROPERTIES = ['textContent', 'visibleText', 'value', 'displayValue', 'visible', 'enabled', 'checked', 'selected', 'expanded', 'pressed', 'paused', 'ended', 'currentTime', 'duration'] as const;

export type ElementProperty = typeof ELEMENT_PROPERTIES[number];

export type ElementValue = string | number | boolean;

type ElementExpectation = { property: ElementProperty; equals: ElementValue; contains?: never } | { property: 'textContent' | 'visibleText' | 'value' | 'displayValue'; contains: string; equals?: never };

export interface ElementReadOptions {
  properties?: ElementProperty[];
  expect?: ElementExpectation;
  timeoutMs?: number;
}

/**
 * 要读的属性，和去掉的不支持名字。一个写错的名字不作废整次读取：照读其余属性，结果里写明可用的名字。
 * expect / timeoutMs 仍严格：等一个读不到的条件只会白等。
 */
export function validateElementRead(options: ElementReadOptions): { properties: ElementProperty[]; unsupported: string[] } {
  const requested: unknown = options.properties ?? [];

  if (!Array.isArray(requested)) throw new Error('properties须是属性名数组；请使用 read_element 的属性列表。');
  const isProperty = (p: unknown): p is ElementProperty => (ELEMENT_PROPERTIES as readonly unknown[]).includes(p);
  const properties = requested.filter(isProperty);
  // 不支持的名字会原样写进页面内容包装之外的说明；程序里的名字可能取自网页，所以只回显像属性名的写法。
  const unsupported = [...new Set(requested.filter(p => !isProperty(p)).map(p => typeof p === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(p) ? p : '(非属性名)'))].slice(0, 10);
  const timeout = options.timeoutMs ?? 0;

  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 5000 || (timeout > 0 && !options.expect)) throw new Error('timeoutMs须为0–5000，等待时必须提供expect条件。');
  const expected = options.expect;

  if (expected !== undefined && (!expected || typeof expected !== 'object')) throw new Error('expect必须是明确的属性条件。');

  if (expected) {
    if (!ELEMENT_PROPERTIES.includes(expected.property) || Object.keys(expected).some(k => !['property', 'equals', 'contains'].includes(k))) throw new Error('不支持的元素条件属性。');

    if (('equals' in expected) === ('contains' in expected)) throw new Error('expect须且只能指定equals或contains。');

    if ('contains' in expected) {
      if (!['textContent', 'visibleText', 'value', 'displayValue'].includes(expected.property) || typeof expected.contains !== 'string' || !expected.contains.length) throw new Error('contains仅用于非空textContent/visibleText/value/displayValue文字条件。');
    } else {
      const kind = ['textContent','visibleText','value','displayValue'].includes(expected.property) ? 'string' : ['currentTime','duration'].includes(expected.property) ? 'number' : 'boolean';
      const mixed = ['expanded','pressed'].includes(expected.property) && expected.equals === 'mixed';

      if (!mixed && (typeof expected.equals !== kind || (kind === 'number' && !Number.isFinite(expected.equals)))) throw new Error(`${expected.property} 的 equals须为${kind}类型；true/false不能加引号，未开始等待。`);
    }
  }

  return { properties: [...new Set([...properties, ...(expected ? [expected.property] : [])])], unsupported };
}

export function unsupportedPropertiesNote(unsupported: readonly string[]): string {
  return `不支持的属性：${unsupported.join('、')}；可用的属性：${ELEMENT_PROPERTIES.join('、')}。`;
}

export function elementMatches(actual: ElementValue, expected: ElementExpectation): boolean {
  return 'contains' in expected ? typeof actual === 'string' && actual.includes(expected.contains!) : actual === expected.equals;
}
