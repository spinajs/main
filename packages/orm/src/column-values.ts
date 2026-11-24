import type { IModelDescriptor } from './interfaces.js';
import type { ModelBase } from './model.js';

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
