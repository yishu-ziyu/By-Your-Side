export type ParseIssue = { code: string; message: string; severity?: "warning" };
export type ParseResult = { meta: { errors: ParseIssue[]; unresolved: string[] } };
export function createParser(schema: object, rootName?: string): { parse(input: string): ParseResult };
