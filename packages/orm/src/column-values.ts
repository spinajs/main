import type { IModelDescriptor } from './interfaces.js';
import type { ModelBase } from './model.js';
import { pkColumns, pkValueOf } from './primary-keys.js';

/**
 * `value` in the database form of `column`: through the column's declared converter, as the column loop of a
 * model-to-SQL converter writes it. No value (null, undefined) and a column without a converter stay as they are.
 * `model` is the row's model; without one the converter gets none, as `StandardObjectToSqlConverter` calls it.
 */
export function columnToDb(descriptor: IModelDescriptor, column: string, value: unknown, model?: ModelBase<unknown>): unknown {
  const declared = descriptor.Columns?.find((c) => c.Name === column);
  if (!declared?.Converter || value === null || value === undefined) {
    return value;
  }

  return declared.Converter.toDB(value, model as ModelBase<unknown>, declared, descriptor.Converters.get(column)?.Options);
}

/** A raw row's column value as the hydrator would set it on the model, so it compares with a model's key. */
export function hydratedValue(descriptor: IModelDescriptor, column: string, row: Record<string, unknown>): unknown {
  const converter = descriptor.Columns?.find((c) => c.Name === column)?.Converter;
  return converter ? converter.fromDB(row[column], row, descriptor.Converters.get(column)?.Options) : row[column];
}

/**
 * The primary key of a key row an insert reported, as `pkValueOf` reads it, with each part in the model's form.
 * A part the row lacks stays as it is: the hydrator never sets a key column from null or undefined either.
 */
export function hydratedKey(descriptor: IModelDescriptor, key: Record<string, unknown>): unknown {
  const keyColumns = pkColumns(descriptor);
  const row = Object.fromEntries(
    Object.entries(key).map(([column, value]) => [column, keyColumns.includes(column) && value !== null && value !== undefined ? hydratedValue(descriptor, column, key) : value]),
  );

  return pkValueOf(row, descriptor);
}
