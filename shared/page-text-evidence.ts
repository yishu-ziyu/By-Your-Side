/** Immutable source fragments from a single browser observation, never live element references. */
export interface PageTextEvidence {
  fragments: Array<{ id: string; text: string; kind: 'text' | 'linebreak' }>;
  truncated: boolean;
}

export function isPageTextEvidence(value: unknown): value is PageTextEvidence {
  if (!value || typeof value !== 'object') return false;
  const v=value as PageTextEvidence;

  return typeof v.truncated==='boolean' && Array.isArray(v.fragments) && v.fragments.length<=3000
    && new Set(v.fragments.map(f=>f?.id)).size===v.fragments.length
    && v.fragments.every(f=>!!f&&typeof f.id==='string'&&f.id.length>0&&f.id.length<=100&&typeof f.text==='string'&&f.text.length<=64000&&(f.kind==='text'||f.kind==='linebreak'))
    && v.fragments.reduce((size,f)=>size+f.text.length,0)<=64000;
}
