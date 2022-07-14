export interface ITableColumnInfo {
  TABLE_NAME: string;
  TABLE_SCHEMA: string;
  COLUMN_NAME: string;
  COLUMN_DEFAULT: string;
  IS_NULLABLE: string;
  DATA_TYPE: string;
  CHARACTER_MAXIMUM_LENGTH: number;
  COLUMN_TYPE: string;
  COLUMN_KEY: string;
  EXTRA: string;
  COLUMN_COMMENT: string;
}

export interface IIndexInfo {
  Key_name: string;
  Column_name: string;
  Non_unique: number;
}
