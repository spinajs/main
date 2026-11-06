/** One index of a live table. The primary key is reported as an index too, with `primary: true`. */
export interface LiveIndex {
  name: string;
  /** In key order. */
  columns: string[];
  unique: boolean;
  primary: boolean;
}

/** One column of a live foreign key; a composite key is one entry per column, in key order. */
export interface LiveForeignKey {
  name: string;
  column: string;
  /** The referenced table. */
  table: string;
  /** The referenced column. */
  references: string;
  /** `NO ACTION`, `RESTRICT`, `CASCADE`, `SET NULL` or `SET DEFAULT`. */
  onDelete?: string;
  onUpdate?: string;
}

/** One column of one index, as a catalog query returns it, in key order. */
export interface IndexColumnRow {
  name: string;
  column: string;
  unique: boolean;
  primary: boolean;
}

export function compareByName(a: { name: string }, b: { name: string }): number {
  if (a.name === b.name) {
    return 0;
  }
  return a.name < b.name ? -1 : 1;
}

export function groupIndexColumns(rows: readonly IndexColumnRow[]): LiveIndex[] {
  const byName = new Map<string, LiveIndex>();
  for (const row of rows) {
    const index = byName.get(row.name) ?? { name: row.name, columns: [], unique: row.unique, primary: row.primary };
    index.columns.push(row.column);
    byName.set(row.name, index);
  }

  return [...byName.values()].sort(compareByName);
}

/** `NO_ACTION` ( SQL Server ) and `no action` become `NO ACTION`. */
export function referentialRule(value: string | null | undefined): string | undefined {
  return value ? value.replace(/_/g, ' ').toUpperCase() : undefined;
}
