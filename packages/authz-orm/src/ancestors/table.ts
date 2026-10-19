export const AUTHZ_RESOURCE_ANCESTOR_TABLE = 'authz_resource_ancestor';

export interface AncestorRow {
  readonly resource_type: string;
  readonly resource_id: string;
  readonly ancestor_type: string;
  readonly ancestor_id: string;
  /** 1 = direct parent. */
  readonly depth: number;
}
