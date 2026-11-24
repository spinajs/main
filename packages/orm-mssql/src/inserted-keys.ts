import { extractModelDescriptor, pkColumns, pkGeneration } from '@spinajs/orm';
import type { IColumnDescriptor, IModelDescriptor, InsertQueryBuilder } from '@spinajs/orm';

/**
 * Key types the batch's `sql_variant` table variable holds exactly, by `tableInfo()` and manifest names. The variant
 * spares the batch the declared type, whose precision `tableInfo()` does not keep; a key of any other type is inserted
 * without `OUTPUT` and reports no key.
 */
const VARIANT_KEY_TYPES = new Set(['tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric', 'uniqueidentifier', 'uuid', 'char', 'varchar', 'nchar', 'nvarchar', 'string']);

export interface OutputKeys {
  descriptor: IModelDescriptor;
  columns: IColumnDescriptor[];
}

const holdsInVariant = (column: IColumnDescriptor | undefined): column is IColumnDescriptor => column !== undefined && (column.AutoIncrement || VARIANT_KEY_TYPES.has(String(column.NativeType).toLowerCase()));

/**
 * The key columns a one-row insert of a model outputs: every key column is known and of a type the batch can hold, and
 * the database generates one of them. A key the caller supplies entirely is already known to the ORM.
 */
export function outputKeys(insert: InsertQueryBuilder): OutputKeys | undefined {
  const descriptor = insert.Model === undefined ? null : extractModelDescriptor(insert.Model);
  const pk = descriptor ? pkColumns(descriptor) : [];
  if (!descriptor || pk.length === 0 || insert.Values.length !== 1 || !pk.some((c) => pkGeneration(descriptor, c) === 'auto')) return undefined;

  const columns = pk.map((name) => descriptor.Columns.find((c) => c.Name === name));
  return columns.every(holdsInVariant) ? { descriptor, columns } : undefined;
}

const INTEGER_TEXT = /^-?\d+$/;

/** An output key value as the model holds it; undefined when it cannot be exact. */
export function keyValue(raw: unknown, column: IColumnDescriptor, descriptor: IModelDescriptor, row: unknown): unknown {
  if (raw === null || raw === undefined) return undefined;
  // decimal and numeric arrive as doubles, rounded past 2^53
  if (typeof raw === 'number' && !Number.isSafeInteger(raw)) return undefined;

  if (column.Converter) {
    try {
      return column.Converter.fromDB(raw, row, descriptor.Converters.get(column.Name)?.Options) ?? undefined;
    } catch {
      // @Int64('number') refuses a value past 2^53
      return undefined;
    }
  }

  // tedious reads bigint as text; without a converter the key stays the number SCOPE_IDENTITY() reported before
  if (typeof raw === 'string' && String(column.NativeType).toLowerCase() === 'bigint') {
    return INTEGER_TEXT.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : undefined;
  }

  return raw;
}
