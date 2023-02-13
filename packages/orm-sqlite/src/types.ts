export interface IIndexInfoList {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

export interface IForeignKeyList {
  id: number;
  seq: number;
  table: string;
  from : string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;

}

export interface IIndexInfo {
  seqno: number;
  cid: number;
  name: string;
}

export interface ITableInfo {
  dflt_value: unknown;
  type: string;
  notnull: number;
  pk: number;
  name: string;
}
