/*
 * Port of coerceData from ajv 8 (lib/compile/validate/dataType.ts), with `coerceTypes: 'array'` and `strictNumbers: true`,
 * as the server validates query, path, header and cookie values.
 * MIT License, Copyright (c) 2015-2021 Evgeny Poberezkin. The full notice is in ajv-formats.ts.
 */
import { checkDataTypes, type JsonType } from './data-type.js';

export type { JsonType } from './data-type.js';

const NOT_COERCED = Symbol('not coerced');

function isNumeric(data: string): boolean {
  return data !== '' && !isNaN(Number(data));
}

const COERCIONS: Record<Exclude<JsonType, 'object'>, (data: unknown) => unknown> = {
  string: (data) => (typeof data === 'number' || typeof data === 'boolean' ? String(data) : data === null ? '' : NOT_COERCED),
  number: (data) => (typeof data === 'boolean' || data === null || (typeof data === 'string' && isNumeric(data)) ? Number(data) : NOT_COERCED),
  // `!(n % 1)` as Ajv writes it: Infinity % 1 is NaN, so 'Infinity' coerces to an integer.
  integer: (data) => (typeof data === 'boolean' || data === null || (typeof data === 'string' && isNumeric(data) && !(Number(data) % 1)) ? Number(data) : NOT_COERCED),
  boolean: (data) => (data === 'false' || data === 0 || data === null ? false : data === 'true' || data === 1 ? true : NOT_COERCED),
  null: (data) => (data === '' || data === 0 || data === false ? null : NOT_COERCED),
  array: (data) => (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean' || data === null ? [data] : NOT_COERCED),
};

/**
 * The value Ajv leaves in place of `value` when it checks `{ type: types }` with `coerceTypes: 'array'`. A value
 * of a listed type, or one that cannot be coerced, comes back unchanged: the type check that follows decides.
 * Types are tried in the order given, as in the schema.
 */
export function ajvCoerce(value: unknown, types: readonly JsonType[]): unknown {
  const coerceTo = types.filter((type): type is Exclude<JsonType, 'object'> => type !== 'object');
  if (coerceTo.length === 0 || !checkDataTypes(types, value, false)) {
    return value;
  }
  let data = value;
  if (Array.isArray(data) && data.length === 1) {
    data = (data as unknown[])[0];
    if (checkDataTypes(types, data, true)) {
      return data;
    }
  }
  for (const type of coerceTo) {
    const coerced = COERCIONS[type](data);
    if (coerced !== NOT_COERCED) {
      return coerced;
    }
  }
  return value;
}

export const coerceString = (value: unknown): unknown => ajvCoerce(value, ['string']);
export const coerceNumber = (value: unknown): unknown => ajvCoerce(value, ['number']);
export const coerceInteger = (value: unknown): unknown => ajvCoerce(value, ['integer']);
export const coerceBoolean = (value: unknown): unknown => ajvCoerce(value, ['boolean']);
export const coerceNull = (value: unknown): unknown => ajvCoerce(value, ['null']);
export const coerceArray = (value: unknown): unknown => ajvCoerce(value, ['array']);
