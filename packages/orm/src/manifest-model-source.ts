import { ManifestMissing, type ColumnFamily, type Manifest, type ModelEntry, type SqlDialectProfile } from '@spinajs/manifest';
import { RawQuery } from './builders/raw.js';
import { ColumnType } from './enums.js';
import type { IColumnDescriptor } from './interfaces.js';
import { familiesOf } from './schema-diff/families.js';
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
  /** `missing`: the table has no such column; `family`: its live type is of another family. */
  kind: 'missing' | 'family';
  message: string;
}

export function manifestModelEntry(manifest: Manifest, className: string, tableName: string): ModelEntry {
  const entry = manifest.models.find((m) => m.className === className && m.tableName === tableName);
  if (!entry) throw new ManifestMissing(`model ${className} (table ${tableName}) is registered but not listed in the manifest models: rebuild the manifest ( spinajs build )`);
  return entry;
}

/** The model's column descriptors from the manifest alone, shaped as a driver's `tableInfo()` shapes them. */
export function manifestColumns(entry: ModelEntry): IColumnDescriptor[] {
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
      Unique: column.primary || sql.unique === true,
      Uuid: false,
      Ignore: false,
      Aggregate: false,
      Virtual: false,
      IsForeignKey: false,
      ForeignKeyDescription: null,
    };
  });
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
    const family = columnSpecOf(column).family;
    const families = familiesOf(found.NativeType || found.Type, dialect);
    if (families && !families.includes(family)) {
      out.push({ ...base, kind: 'family', message: `column ${entry.tableName}.${column.name} is ${found.NativeType} on connection ${connection}, model ${entry.className} declares ${family}` });
    }
  }
  return out;
}
