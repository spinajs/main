export interface IIndexInfo {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

export interface ITableInfo {
  dflt_value: unknown;
  type: string;
  notnull: number;
  pk: number;
  name: string;
}
