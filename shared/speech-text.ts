const sentence = (text: string): string => /[。！？.!?；;]$/.test(text) ? text : `${text}。`;

function inlineText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s<>）)。，！？；，]+/gi, '（链接在侧栏）')
    .replace(/<[^>]*>/g, '')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/\*([^*]+)\*|_([^_]+)_/g, '$1$2')
    .replace(/\\([\\`*{}\[\]()#+.!_>|-])/g, '$1')
    .trim();
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => inlineText(cell.replace(/\\\|/g, '|')));
}

export function speechText(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const fence = /^( {0,3})(`{3,}|~{3,})/.exec(lines[i]!);
    if (fence) {
      const marker = fence[2]![0]!;
      const end = new RegExp(`^\\s*${marker}{${fence[2]!.length},}\\s*$`);
      while (i + 1 < lines.length && !end.test(lines[i + 1]!)) i++;
      if (i + 1 < lines.length) i++;
      output.push('代码在侧栏。');
      continue;
    }
    const next = lines[i + 1]?.trim() ?? '';
    if (line.includes('|') && /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(next)) {
      const headers = cells(line);
      const rows: string[][] = [];
      i++;
      while (i + 1 < lines.length && lines[i + 1]!.trim().includes('|') && lines[i + 1]!.trim()) rows.push(cells(lines[++i]!));
      for (const row of rows.slice(0, 5)) {
        const subject = row[0] ?? '';
        const details = row.slice(1).flatMap((value, index) => value ? [`${headers[index + 1] || `第${index + 2}列`}是${value}`] : []);
        const text = [subject, details.join('，')].filter(Boolean).join('：');
        if (text) output.push(sentence(text));
      }
      if (rows.length > 5) output.push(`另外还有 ${rows.length - 5} 项，完整内容在侧栏。`);
      continue;
    }
    if (/^(?:\s*[-*_]){3,}\s*$/.test(line)) continue;
    const item = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/.test(line);
    const text = inlineText(line.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, ''));
    if (text) output.push(item ? sentence(text) : text);
  }
  return output.join('\n');
}
