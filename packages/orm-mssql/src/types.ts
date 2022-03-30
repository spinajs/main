export interface ITableColumnInfo {
  TABLE_CATALOG: string;
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  ORDINAL_POSITION: number;
  COLUMN_DEFAULT: any | null;
  IS_NULLABLE: boolean;
  DATA_TYPE: string;
  CHARACTER_MAXIMUM_LENGTH: number;
}

export interface IIndexInfo {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  CONSTRAINT_TYPE: string;
}
