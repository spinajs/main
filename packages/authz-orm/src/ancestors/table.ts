export const AUTHZ_RESOURCE_ANCESTOR_TABLE = 'authz_resource_ancestor';

export interface AncestorRow {
  readonly resource_type: string;
  readonly resource_id: string;
  readonly ancestor_type: string;
  readonly ancestor_id: string;
  /** 1 = direct parent. */
  readonly depth: number;
}

export const ANCESTOR_COLUMNS = ['resource_type', 'resource_id', 'ancestor_type', 'ancestor_id', 'depth'] as const;

/** Rows per INSERT: 5 parameters each stays under MSSQL's 2100 parameters per statement. */
export const ROW_CHUNK = 400;

/** Ids per IN list, for the same limit. */
export const ID_CHUNK = 1000;

export function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
