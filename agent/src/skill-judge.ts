/** Closed-set argument selection: only quoted materials or explicit key=value fields. */
export function skillSourceValues(text: string): string[] {
  const values = [
    ...[...text.matchAll(/[「“"]([^」”"\r\n]{1,500})[」”"]/gu)].map(match => match[1]!),
    ...[...text.matchAll(/(?:^|[\s,，;；：:])[^=：:\s,，;；「」“”"]{1,50}\s*[=：:]\s*([^=：:\r\n,，;；]{1,500})(?=$|[\r\n,，;；])/gu)].map(match => match[1]!),
  ].flatMap(value => {
    const trimmed = value.trim();

    return trimmed ? [trimmed] : [];
  });

  return [...new Set(values)].slice(0, 12);
}
