import { ConfigurationEntryType, IConfigurationEntryMeta } from '@spinajs/configuration-db-source';

/** A plain JSON Schema fragment. */
type JsonSchema = Record<string, unknown>;

/**
 * Base JSON Schema per configuration `Type`. These shapes are constant - the
 * per-entry `Meta` ( bounds / allowed values ) is folded on top at request time
 * by {@link valueSchema}.
 *
 * Validation only - it asserts the incoming value is acceptable. Coercion into
 * the typed / canonical stored form is the converter's job ( see
 * DbConfigValueConverter ), so eg. a `date` is just a `format: date` string
 * here, not a luxon DateTime.
 */
export const VALUE_SCHEMAS: Record<ConfigurationEntryType, JsonSchema> = {
  string: { type: 'string' },
  file: { type: 'string' },
  oneOf: { type: 'string' },
  manyOf: { type: 'array', uniqueItems: true, items: { type: 'string' } },
  number: { type: 'integer' },
  float: { type: 'number' },
  range: { type: 'number' },
  // a real boolean or the canonical / numeric string forms the converter understands
  boolean: { anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['0', '1', 'true', 'false'] }] },
  date: { type: 'string', format: 'date' },
  time: { type: 'string', format: 'time' },
  datetime: { type: 'string', format: 'date-time' },
  'date-range': { type: 'array', items: { type: 'string', format: 'date' } },
  'time-range': { type: 'array', items: { type: 'string', format: 'time' } },
  'datetime-range': { type: 'array', items: { type: 'string', format: 'date-time' } },
  json: {},
};

/**
 * Resolves the value schema for an entry: the constant base schema for its
 * `Type` with the entry `Meta` constraints applied.
 *
 * The constraints target the schema "leaf" - the `items` schema for array types
 * ( manyOf / *-range ), otherwise the schema itself - so allowed values and
 * bounds land on the element being validated regardless of arity.
 *
 * Fed to `DataValidator` ( ajv ) in the controller, after the entry - and so its
 * Type / Meta - has been loaded from the db. It can't live on the request DTO
 * schema, which is validated before that lookup when the type is still unknown.
 */
export function valueSchema(type: ConfigurationEntryType, meta?: IConfigurationEntryMeta): JsonSchema {
  const schema = structuredClone(VALUE_SCHEMAS[type]);

  if (!meta) {
    return schema;
  }

  const leaf = (schema.items as JsonSchema) ?? schema;

  // oneOf / manyOf both restrict the string element to an allowed set
  const allowed = meta.oneOf ?? meta.manyOf;
  if (allowed) {
    leaf.enum = allowed;
  }
  if (meta.min !== undefined) {
    leaf.minimum = meta.min;
  }
  if (meta.max !== undefined) {
    leaf.maximum = meta.max;
  }
  // minDate / maxDate are ISO strings in the JSON Meta; ajv-formats
  // formatMinimum / formatMaximum compare date / time / date-time formats
  if (meta.minDate !== undefined) {
    leaf.formatMinimum = meta.minDate;
  }
  if (meta.maxDate !== undefined) {
    leaf.formatMaximum = meta.maxDate;
  }

  return schema;
}
