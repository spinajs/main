import { ColumnType } from './enums.js';
import { IColumnDescriptor, IModelDescriptor } from './interfaces.js';

/**
 * SQL column type → JSON-schema shape. Add a new type by adding a row.
 * Anything not listed falls back to `string` (safe default for text/enum/uuid/blob…).
 */
const SQL_TYPE_TO_SCHEMA: Record<string, any> = {
  [ColumnType.TINY_INTEGER]: { type: 'integer' },
  [ColumnType.SMALL_INTEGER]: { type: 'integer' },
  [ColumnType.MEDIUM_INTEGER]: { type: 'integer' },
  [ColumnType.INTEGER]: { type: 'integer' },
  [ColumnType.BIG_INTEGER]: { type: 'integer' },
  [ColumnType.DECIMAL]: { type: 'number' },
  [ColumnType.FLOAT]: { type: 'number' },
  [ColumnType.DOUBLE]: { type: 'number' },
  [ColumnType.BIT]: { type: 'number' },
  [ColumnType.BOOLEAN]: { type: 'boolean' },
  [ColumnType.DATE]: { type: 'string', format: 'date' },
  [ColumnType.DATE_TIME]: { type: 'string', format: 'date-time' },
  [ColumnType.TIMESTAMP]: { type: 'string', format: 'date-time' },
  [ColumnType.JSON]: { type: 'object' },
  [ColumnType.SET]: { type: 'array', items: { type: 'string' } },
};

/**
 * Build a JSON schema from a model's columns, stored on `descriptor.Schema` at
 * model load and reused by validation and http-swagger. `Ignore` columns (e.g.
 * `@Ignore()`) are excluded; relations are omitted (a consumer concern, not part
 * of the row-level data schema).
 */
export function buildModelJsonSchema(descriptor: IModelDescriptor): any {
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const col of descriptor.Columns ?? []) {
    if (!col || col.Ignore || !col.Name) {
      continue;
    }
    properties[col.Name] = columnToSchema(col);
    if (!col.Nullable && !col.AutoIncrement) {
      required.push(col.Name);
    }
  }

  const schema: any = { type: 'object', properties };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

/** Map a column descriptor to a JSON-schema property based on its SQL type. */
function columnToSchema(col: IColumnDescriptor): any {
  const converter = (col.Converter as { constructor?: { name?: string } } | null | undefined)?.constructor?.name;

  const schema: any = { ...(SQL_TYPE_TO_SCHEMA[col.Type] ?? { type: 'string' }) };

  if (converter === 'BooleanValueConverter') {
    schema.type = 'boolean';
    delete schema.format;
  }

  if (schema.type === 'string' && col.MaxLength > 0) {
    schema.maxLength = col.MaxLength;
  }

  if (col.Comment) {
    schema.description = col.Comment;
  }

  if (col.Nullable) {
    schema.nullable = true;
  }

  return schema;
}
