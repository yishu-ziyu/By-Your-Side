/** Fixed, read-only element properties. No model-supplied code or getters. */
export const ELEMENT_PROPERTIES = ['textContent', 'value', 'visible', 'enabled', 'checked', 'selected', 'expanded', 'pressed', 'paused', 'ended', 'currentTime', 'duration'] as const;
export type ElementProperty = typeof ELEMENT_PROPERTIES[number];
export type ElementValue = string | number | boolean;
export type ElementExpectation = { property: ElementProperty; equals: ElementValue; contains?: never } | { property: 'textContent' | 'value'; contains: string; equals?: never };
export interface ElementReadOptions {
  properties?: ElementProperty[];
  expect?: ElementExpectation;
  timeoutMs?: number;
}
export function validateElementRead(options: ElementReadOptions): ElementProperty[] {
  const properties = options.properties ?? [];
  if (!Array.isArray(properties) || properties.length > ELEMENT_PROPERTIES.length || properties.some(p => !ELEMENT_PROPERTIES.includes(p))) throw new Error('不支持的元素属性；请使用 read_element 的属性列表。');
  const timeout = options.timeoutMs ?? 0;
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 5000 || (timeout > 0 && !options.expect)) throw new Error('timeoutMs须为0–5000，等待时必须提供expect条件。');
  const expected = options.expect;
  if (expected !== undefined && (!expected || typeof expected !== 'object')) throw new Error('expect必须是明确的属性条件。');
  if (expected) {
    if (!ELEMENT_PROPERTIES.includes(expected.property) || Object.keys(expected).some(k => !['property', 'equals', 'contains'].includes(k))) throw new Error('不支持的元素条件属性。');
    if (('equals' in expected) === ('contains' in expected)) throw new Error('expect须且只能指定equals或contains。');
    if ('contains' in expected) {
      if (!['textContent', 'value'].includes(expected.property) || typeof expected.contains !== 'string' || !expected.contains.length) throw new Error('contains仅用于非空textContent/value文字条件。');
    } else {
      const kind = ['textContent','value'].includes(expected.property) ? 'string' : ['currentTime','duration'].includes(expected.property) ? 'number' : 'boolean';
      const mixed = ['expanded','pressed'].includes(expected.property) && expected.equals === 'mixed';
      if (!mixed && (typeof expected.equals !== kind || (kind === 'number' && !Number.isFinite(expected.equals)))) throw new Error(`${expected.property} 的 equals须为${kind}类型；true/false不能加引号，未开始等待。`);
    }
  }
  return [...new Set([...properties, ...(expected ? [expected.property] : [])])];
}
export function elementMatches(actual: ElementValue, expected: ElementExpectation): boolean {
  return 'contains' in expected ? typeof actual === 'string' && actual.includes(expected.contains!) : actual === expected.equals;
}
