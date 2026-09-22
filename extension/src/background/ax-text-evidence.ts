import type { PageTextEvidence } from '../../../shared/page-text-evidence.js';
import type { AxNodeLite } from './axtree.js';

/** Preserve source text and explicit breaks before the compact control snapshot clips them. */
export function axTextEvidence(nodes: readonly AxNodeLite[]): PageTextEvidence {
  const byId=new Map(nodes.map(node=>[node.nodeId,node]));
  const fragments: PageTextEvidence['fragments']=[], seen=new Set<string>();
  let size=0, truncated=false;

  const walk=(node:AxNodeLite) => {
    if (seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const role=node.role?.value;

    if (role==='InlineTextBox') return;

    if (!node.ignored && (role==='StaticText'||role==='LineBreak')) {
      const text=role==='LineBreak'?'\n':node.name?.value??'';

      if (fragments.length>=3000||size+text.length>64000) { truncated=true;

 return; }

      if (text) { fragments.push({id:`ax-${node.nodeId}`,text,kind:role==='LineBreak'?'linebreak':'text'}); size+=text.length; }

      return;
    }

    for (const id of node.childIds??[]) { const child=byId.get(id);

 if(child)walk(child); }
  };

  for (const root of nodes.filter(node=>!node.parentId||!byId.has(node.parentId)))walk(root);

  return {fragments,truncated};
}
