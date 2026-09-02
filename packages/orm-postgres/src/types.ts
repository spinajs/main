/** One row of `information_schema.columns` — only the fields tableInfo() reads. */
export interface ITableColumnInfo {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  is_identity: 'YES' | 'NO';
}

/** One row of the constraint probe joining table_constraints and key_column_usage. */
export interface IConstraintInfo {
  column_name: string;
  constraint_type: 'PRIMARY KEY' | 'UNIQUE' | 'FOREIGN KEY' | 'CHECK';
}
