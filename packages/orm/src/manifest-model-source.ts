import { ManifestMissing, type ColumnFamily, type ColumnSqlSpec, type Manifest, type ModelColumn, type ModelEntry, type SqlDialectProfile } from '@spinajs/manifest';
import { RawQuery } from './builders/raw.js';
import { ColumnType } from './enums.js';
import type { IColumnDescriptor } from './interfaces.js';
import { familiesOf, reportsNullability } from './schema-diff/families.js';
import { autoIncrementOf, columnSpecOf } from './schema-diff/target.js';

// buildModelJsonSchema and the converter lookup read ColumnType names, not families; uuid has no ColumnType and keeps its name
const FAMILY_TYPES: Record<ColumnFamily, string> = {
  integer: ColumnType.INTEGER,
  bigint: ColumnType.BIG_INTEGER,
  decimal: ColumnType.DECIMAL,
  float: ColumnType.FLOAT,
  text: ColumnType.STRING,
  boolean: ColumnType.BOOLEAN,
  date: ColumnType.DATE,
  time: ColumnType.TIME,
  datetime: ColumnType.DATE_TIME,
  json: ColumnType.JSON,
  binary: ColumnType.BINARY,
  uuid: 'uuid',
  enum: ColumnType.ENUM,
};

export interface IColumnDrift {
  model: string;
  table: string;
  connection: string;
  column: string;
  /**
   * `missing`: the table has no such column; `family`: its live type is of another family; `nullability`: the model
   * requires a value and states no default, while the table allows NULL or fills a default (D9: writes check the model).
   */
  kind: 'missing' | 'family' | 'nullability';
  message: string;
}

/** Throws ManifestMissing unless exactly one manifest model has the class and table name: a registered class does not say which package declared it. */
export function manifestModelEntry(manifest: Manifest, className: string, tableName: string): ModelEntry {
  const entries = manifest.models.filter((m) => m.className === className && m.tableName === tableName);
  if (entries.length === 0) throw new ManifestMissing(`model ${className} (table ${tableName}) is registered but not listed in the manifest models: rebuild the manifest ( spinajs build )`);
  if (entries.length > 1) throw new ManifestMissing(`model ${className} (table ${tableName}) matches more than one manifest model (${entries.map((e) => e.id).join(', ')})`);
  return entries[0];
}

function uniqueKey(entry: ModelEntry, sql: ColumnSqlSpec, dialect: SqlDialectProfile | undefined): boolean {
  const rule = dialect?.uniquePrimaryKey ?? 'all';
  if (rule !== 'indexed') return rule === 'all';
  if (entry.columns.filter((c) => c.primary).length !== 1) return false;
  const rowid = dialect?.rowidType;
  if (rowid === undefined) return true;
  return sql.nativeType !== undefined ? sql.nativeType.toLowerCase() !== rowid : !familiesOf(rowid, dialect)?.includes(sql.family);
}

/** The model's column descriptors from the manifest alone, shaped as `dialect`'s driver's `tableInfo()` shapes them. */
export function manifestColumns(entry: ModelEntry, dialect?: SqlDialectProfile): IColumnDescriptor[] {
  return entry.columns.map((column) => {
    const sql = columnSpecOf(column);
    const native = sql.nativeType ?? FAMILY_TYPES[sql.family];
    return {
      Name: column.name,
      Type: native,
      NativeType: native,
      MaxLength: sql.length ?? -1,
      Comment: '',
      DefaultValue: sql.default !== null && typeof sql.default === 'object' ? RawQuery.create(sql.default.raw) : sql.default,
      Unsigned: sql.unsigned ?? false,
      Nullable: column.nullable,
      PrimaryKey: column.primary,
      AutoIncrement: autoIncrementOf({ sql, primary: column.primary }),
      Converter: null,
      Schema: undefined,
      Unique: (column.primary && uniqueKey(entry, sql, dialect)) || sql.unique === true,
      Uuid: false,
      Ignore: false,
      Aggregate: false,
      Virtual: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
    };
  });
}

/** How the table accepts a write without a value of a column the model requires without a default, if it does. */
function looserInTable(column: ModelColumn, sql: ColumnSqlSpec, found: IColumnDescriptor, dialect: SqlDialectProfile | undefined): string | undefined {
  if (column.nullable || column.primary || sql.default !== undefined) return undefined;
  if (found.Nullable && reportsNullability(dialect, sql.family)) return 'is nullable';
  return found.DefaultValue !== null && found.DefaultValue !== undefined ? 'has a default' : undefined;
}

/** D9: only declared columns are checked; a table column no model declares is a partial model (D19), never drift. */
export function columnDrift(entry: ModelEntry, live: IColumnDescriptor[], dialect: SqlDialectProfile | undefined, connection: string): IColumnDrift[] {
  const fold = dialect?.caseInsensitiveIdentifiers ? (name: string) => name.toLowerCase() : (name: string) => name;
  const out: IColumnDrift[] = [];
  for (const column of entry.columns) {
    const base = { model: entry.className, table: entry.tableName, connection, column: column.name };
    const found = live.find((l) => fold(l.Name) === fold(column.name));
    if (!found) {
      out.push({ ...base, kind: 'missing', message: `column ${column.name} of model ${entry.className} is missing from table ${entry.tableName} on connection ${connection}` });
      continue;
    }
    const sql = columnSpecOf(column);
    const families = familiesOf(found.NativeType || found.Type, dialect);
    if (families && !families.includes(sql.family)) {
      out.push({ ...base, kind: 'family', message: `column ${entry.tableName}.${column.name} is ${found.NativeType} on connection ${connection}, model ${entry.className} declares ${sql.family}` });
    }
    const looser = looserInTable(column, sql, found, dialect);
    if (looser) {
      out.push({ ...base, kind: 'nullability', message: `column ${entry.tableName}.${column.name} ${looser} on connection ${connection}, model ${entry.className} requires a value and states no default: writes without one fail` });
    }
  }
  return out;
}
