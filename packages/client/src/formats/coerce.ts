/*!
 * Port of coerceData from ajv 8 (lib/compile/validate/dataType.ts), with `coerceTypes: 'array'` and `strictNumbers: true`,
 * as the server validates query, path, header and cookie values. The server then refuses a non-finite number, so a value
 * that would coerce to one is left as it is.
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
  // `!(n % 1)` as Ajv writes it: Infinity % 1 is NaN, so 'Infinity' coerces to an integer, which ajvCoerce then refuses.
  integer: (data) => (typeof data === 'boolean' || data === null || (typeof data === 'string' && isNumeric(data) && !(Number(data) % 1)) ? Number(data) : NOT_COERCED),
  boolean: (data) => (data === 'false' || data === 0 || data === null ? false : data === 'true' || data === 1 ? true : NOT_COERCED),
  null: (data) => (data === '' || data === 0 || data === false ? null : NOT_COERCED),
  array: (data) => (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean' || data === null ? [data] : NOT_COERCED),
};

/**
 * The value Ajv leaves in place of `value` when it checks `{ type: types }` with `coerceTypes: 'array'`. A value
 * of a listed type, or one that cannot be coerced or would become a non-finite number, comes back unchanged: the type check
 * that follows decides.
 * Types are tried in the order given, as in the schema.
 */
export function ajvCoerce(value: unknown, types: readonly JsonType[]): unknown {
  const result = ajvCoerceInPlace(value, types);
  if (!result.set) return value;
  return typeof result.local === 'number' && !Number.isFinite(result.local) ? value : result.local;
}

/**
 * The variable Ajv's compiled code reads the data from once the type check has run, and whether it assigned that to the
 * parent. A one-item array is unwrapped into the variable before anything is tried, and stays unwrapped when no
 * coercion follows: the next keyword of the node reads the item.
 * A coercion to a non-finite number is returned as Ajv makes it: the server refuses it afterwards, and the replay has to
 * see it to refuse it too.
 */
export function ajvCoerceInPlace(value: unknown, types: readonly JsonType[]): { local: unknown; set: boolean } {
  const coerceTo = types.filter((type): type is Exclude<JsonType, 'object'> => type !== 'object');
  if (coerceTo.length === 0 || !checkDataTypes(types, value, false)) {
    return { local: value, set: false };
  }
  let data = value;
  if (Array.isArray(data) && data.length === 1) {
    data = (data as unknown[])[0];
    if (checkDataTypes(types, data, true)) {
      return { local: data, set: true };
    }
  }
  for (const type of coerceTo) {
    const coerced = COERCIONS[type](data);
    if (coerced !== NOT_COERCED) {
      return { local: coerced, set: true };
    }
  }
  return { local: data, set: false };
}

/** The value Ajv's variable holds after the type check of `types`, for types fixed in advance. */
export function coerceLocal(types: readonly JsonType[]): (value: unknown) => unknown {
  return (value) => ajvCoerceInPlace(value, types).local;
}

/** `ajvCoerceInPlace` for types fixed in advance: what a replay plan holds. */
export function coerceIn(types: readonly JsonType[]): CoerceIn {
  return Object.assign((value: unknown) => ajvCoerceInPlace(value, types), { numeric: types.includes('number') || types.includes('integer') });
}

/** What `coerceIn` makes; `numeric` when the node's `type` holds a number, whose finite check fails on an infinity. */
export type CoerceIn = ((value: unknown) => { local: unknown; set: boolean }) & { numeric?: boolean };

export const coerceString = (value: unknown): unknown => ajvCoerce(value, ['string']);
export const coerceNumber = (value: unknown): unknown => ajvCoerce(value, ['number']);
export const coerceInteger = (value: unknown): unknown => ajvCoerce(value, ['integer']);
export const coerceBoolean = (value: unknown): unknown => ajvCoerce(value, ['boolean']);
export const coerceNull = (value: unknown): unknown => ajvCoerce(value, ['null']);
export const coerceArray = (value: unknown): unknown => ajvCoerce(value, ['array']);

/*
 * A route argument typed `number`, `boolean` or `bigint` is converted by SpinaJS (`RouteArgs.fromRuntimeType` in
 * @spinajs/http) before its schema is checked, whatever wire it comes from; an absent one is not checked at all.
 * A value whose conversion throws on the server (500) is left as it is, so the schema refuses it.
 */

/** `Number(value)`, with `''`, `null` and `undefined` absent. */
export function numberArgument(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    return Number(value);
  } catch {
    return value;
  }
}

/** `true` for a boolean `true`, `1` or any case of `'true'`; every other value is `false`. */
export function booleanArgument(value: unknown): unknown {
  if (typeof value === 'boolean') return value;
  try {
    // String(value) of a JSON value: an array joins its items, and nothing else reads 'true'.
    const text = typeof value === 'string' ? value : Array.isArray(value) ? value.join(',') : '';
    return value ? value === 1 || text.toLowerCase() === 'true' : false;
  } catch {
    return value;
  }
}

/** Whether `BigInt(value)` accepts the value; a bigint argument is not checked against its schema. */
export function isBigIntArgument(value: unknown): boolean {
  try {
    BigInt(value as string);
    return true;
  } catch {
    return false;
  }
}
