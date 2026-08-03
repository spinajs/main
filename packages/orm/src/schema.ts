import { ColumnType } from './enums.js';
import { IColumnDescriptor, IModelDescriptor } from './interfaces.js';

/**
 * SQL column type → JSON-schema shape; unlisted types fall back to `string`.
 *
 * The keys must be the strings a DRIVER puts in `IColumnDescriptor.Type`. Every driver
 * stores the column's own `DATA_TYPE` verbatim ( see orm-mysql / orm-mssql `tableInfo` ),
 * so a `ColumnType` member whose value does not spell the SQL type exactly the way the
 * database reports it will never match, and the column silently falls back to `string`.
 * That is why 'datetime' sits here next to `ColumnType.DATE_TIME` ( = 'dateTime' ), which
 * neither MySQL nor MSSQL ever emits.
 *
 * Known remaining mismatches with mysql2's real output, left alone on purpose - correcting
 * them changes an already-published schema for columns nobody has complained about:
 *   - `bit` arrives as a Buffer, not a number,
 *   - `set` arrives as a comma-separated string unless SetValueConverter is attached,
 *   - `blob` / `binary` / `varbinary` arrive as Buffers and fall through to `string`.
 *
 * The values here are what a client may SEND. Where the driver hands something else BACK -
 * mysql2's stringified DECIMAL - that driver says so through `OrmDriver.ResponseSchemaTypes`
 * rather than bending this shared map, which every driver reads.
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
  // MySQL and MSSQL both report DATETIME as 'datetime'; ColumnType.DATE_TIME above never matches.
  datetime: { type: 'string', format: 'date-time' },
  [ColumnType.TIMESTAMP]: { type: 'string', format: 'date-time' },
  [ColumnType.JSON]: { type: 'object' },
  [ColumnType.SET]: { type: 'array', items: { type: 'string' } },
};

/**
 * Which side of the wire a model schema describes. `request` is what a client may SEND
 * ( the model used as `@Body()` ), `response` is what the API hands BACK.
 */
export type ModelSchemaKind = 'request' | 'response';

/**
 * Builds a JSON schema from a model's columns, stored on `descriptor.Schema` /
 * `descriptor.ResponseSchema` at model load. `Ignore` columns are excluded and relations
 * are omitted.
 *
 * The two flavours differ in three ways, all of them facts about what a response IS:
 *   - `descriptor.Hidden` ( the model's `@Hidden()` properties ) is dropped: `dehydrate()` and
 *     `dehydrateWithRelations()` omit those columns unconditionally, so no response can
 *     ever carry them - rbac's User hides `Password`,
 *   - the driver may override a type it returns differently from what it accepts,
 *   - nothing is `required`: a response is partial by construction ( `skipUndefined`
 *     drops columns the query did not select ).
 *
 * @param descriptor - the model descriptor to describe
 * @param kind - which contract to build, defaults to the write one
 */
export function buildModelJsonSchema(descriptor: IModelDescriptor, kind: ModelSchemaKind = 'request'): any {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  const hidden = kind === 'response' ? new Set(descriptor.Hidden ?? []) : new Set<string>();
  const overrides = kind === 'response' ? driverResponseTypes(descriptor) : {};

  for (const col of descriptor.Columns ?? []) {
    if (!col || col.Ignore || !col.Name || hidden.has(col.Name)) {
      continue;
    }
    properties[col.Name] = columnToSchema(col, overrides);
    if (!col.Nullable && !col.AutoIncrement) {
      required.push(col.Name);
    }
  }

  const schema: any = { type: 'object', properties };
  if (kind === 'request' && required.length > 0) {
    schema.required = required;
  }
  return schema;
}

/**
 * Per-SQL-type response overrides declared by the driver this model is bound to, or an
 * empty map for a model with no connection yet ( then the shared defaults stand ).
 *
 * Read structurally rather than through the OrmDriver type: this module is imported by
 * the descriptor building path and must not pull the driver module in with it.
 *
 * @param descriptor - the model descriptor whose driver is asked
 */
function driverResponseTypes(descriptor: IModelDescriptor): Record<string, any> {
  return (descriptor.Driver as { ResponseSchemaTypes?: Record<string, any> } | null | undefined)?.ResponseSchemaTypes ?? {};
}

/**
 * Maps a column descriptor to a JSON-schema property based on its SQL type.
 * Adds `maxLength`, `description` and `nullable` when the column has them.
 *
 * @param col - column to describe
 * @param overrides - per-type shapes that win over the shared map ( response flavour only )
 */
function columnToSchema(col: IColumnDescriptor, overrides: Record<string, any> = {}): any {
  const converter = (col.Converter as { constructor?: { name?: string } } | null | undefined)?.constructor?.name;

  const schema: any = { ...(overrides[col.Type] ?? SQL_TYPE_TO_SCHEMA[col.Type] ?? { type: 'string' }) };

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
