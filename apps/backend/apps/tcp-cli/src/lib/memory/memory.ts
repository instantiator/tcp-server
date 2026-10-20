/** A role's memory as returned by the memory routes. */
export interface RoleMemory {
  id: string;
  content: string;
  tags: string[];
  agentId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Splits a comma-separated `--tags` value, trimming and dropping empty entries. */
export function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}
