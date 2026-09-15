import { ConfigurationEntryType, IConfigurationEntryMeta } from '@spinajs/configuration-db-source';
import type { IValidationError } from '@spinajs/validation';

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
 * `Type` with the entry `Meta` constraints applied, combined via `allOf` with
 * the schema registered in `@spinajs/validation` under `schemaRef`, if given.
 *
 * The constraints target the schema "leaf" - the `items` schema for array types
 * ( manyOf / *-range ), otherwise the schema itself - so allowed values and
 * bounds land on the element being validated regardless of arity. The
 * registered schema always applies to the whole value.
 *
 * Fed to `DataValidator` ( ajv ) in the controller, after the entry - and so its
 * Type / Meta - has been loaded from the db. It can't live on the request DTO
 * schema, which is validated before that lookup when the type is still unknown.
 *
 * @param schemaRef - `$id` of a registered schema for this entry, ie. its config path
 */
export function valueSchema(
  type: ConfigurationEntryType,
  meta?: IConfigurationEntryMeta,
  schemaRef?: string,
): JsonSchema {
  const schema = typeSchema(type, meta);
  return schemaRef ? { allOf: [schema, { $ref: schemaRef }] } : schema;
}

function typeSchema(type: ConfigurationEntryType, meta?: IConfigurationEntryMeta): JsonSchema {
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

/**
 * Joins validator errors reported for `field` ( validated wrapped as `{ [field]: value }` )
 * into a single 400 message.
 */
export function formatValidationErrors(field: string, errors: IValidationError[] | null): string {
  const messages = (errors ?? []).map((e) =>
    `${field}${e.instancePath ? e.instancePath.replace(`/${field}`, '') : ''} ${e.message ?? 'is invalid'}`.trim(),
  );

  // with allErrors on, the type schema and the registered schema report the same failure from both allOf branches
  return [...new Set(messages)].join('; ') || `invalid value for ${field}`;
}
