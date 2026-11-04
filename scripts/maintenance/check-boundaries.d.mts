export function dependencyViolations(file: string, source: string): Promise<string[]>;
export function checkBoundaries(root: string): Promise<{ files: number; failures: string[] }>;
