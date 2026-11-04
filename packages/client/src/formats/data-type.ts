/*
 * Port of checkDataType and checkDataTypes from ajv 8 (lib/compile/validate/dataType.ts), with `strictNumbers: true`.
 * MIT License, Copyright (c) 2015-2021 Evgeny Poberezkin. The full notice is in ajv-formats.ts.
 */

export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object';

function hasType(type: JsonType, data: unknown): boolean {
  switch (type) {
    case 'null':
      return data === null;
    case 'array':
      return Array.isArray(data);
    case 'object':
      return !!data && typeof data === 'object' && !Array.isArray(data);
    case 'integer':
      return typeof data === 'number' && !(data % 1) && !isNaN(data) && isFinite(data);
    case 'number':
      return typeof data === 'number' && isFinite(data);
    default:
      return typeof data === type;
  }
}

/**
 * Ajv's generated type condition. For several types it is a conjunction in both modes, so `correct` mode with two
 * types (only used after Ajv unwraps a one-item array) never holds: Ajv's code does exactly that.
 */
export function checkDataTypes(types: readonly JsonType[], data: unknown, correct: boolean): boolean {
  const check = (type: JsonType): boolean => hasType(type, data) === correct;
  if (types.length === 1) {
    return check(types[0]);
  }
  const remaining = new Set(types);
  let condition = true;
  if (remaining.has('array') && remaining.has('object')) {
    const notObject = typeof data !== 'object';
    condition = remaining.has('null') ? notObject : !data || notObject;
    remaining.delete('null');
    remaining.delete('array');
    remaining.delete('object');
  }
  if (remaining.has('number')) {
    remaining.delete('integer');
  }
  for (const type of remaining) {
    condition = condition && check(type);
  }
  return condition;
}
