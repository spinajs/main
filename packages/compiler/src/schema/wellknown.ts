import type ts from 'typescript';
import type { JsonSchema, TypeHandler } from './derive.js';

const LIB = /[\\/]lib\.[^\\/]*\.d\.ts$/;
const NODE = /[\\/]@types[\\/]node[\\/]/;
const LUXON = /[\\/]luxon[\\/]/;
const DATE_TIME: JsonSchema = { type: 'string', format: 'date-time' };
const BINARY: JsonSchema = { type: 'string', format: 'binary' };

export interface WellKnownType {
  name: string;
  from: RegExp;
  schema: JsonSchema;
}

/** Keyed by symbol name and the file that declares it, so a user class named `Stream` is not mistaken for node's. */
export const WELL_KNOWN_TYPES: WellKnownType[] = [
  { name: 'Date', from: LIB, schema: DATE_TIME },
  { name: 'DateTime', from: LUXON, schema: DATE_TIME },
  { name: 'Buffer', from: NODE, schema: BINARY },
  { name: 'Uint8Array', from: LIB, schema: BINARY },
  { name: 'Int8Array', from: LIB, schema: BINARY },
  { name: 'Uint8ClampedArray', from: LIB, schema: BINARY },
  { name: 'Int16Array', from: LIB, schema: BINARY },
  { name: 'Uint16Array', from: LIB, schema: BINARY },
  { name: 'Int32Array', from: LIB, schema: BINARY },
  { name: 'Uint32Array', from: LIB, schema: BINARY },
  { name: 'Float32Array', from: LIB, schema: BINARY },
  { name: 'Float64Array', from: LIB, schema: BINARY },
  { name: 'BigInt64Array', from: LIB, schema: BINARY },
  { name: 'BigUint64Array', from: LIB, schema: BINARY },
  { name: 'ArrayBuffer', from: LIB, schema: BINARY },
  { name: 'Blob', from: LIB, schema: BINARY },
  { name: 'Stream', from: NODE, schema: BINARY },
  { name: 'Readable', from: NODE, schema: BINARY },
  { name: 'Writable', from: NODE, schema: BINARY },
  { name: 'Duplex', from: NODE, schema: BINARY },
  { name: 'Transform', from: NODE, schema: BINARY },
  { name: 'PassThrough', from: NODE, schema: BINARY },
  { name: 'ReadStream', from: NODE, schema: BINARY },
];

export function wellKnownSchema(type: ts.Type): JsonSchema | undefined {
  const symbol = type.getSymbol() ?? type.aliasSymbol;
  const declaration = symbol?.declarations?.[0];
  if (!symbol || !declaration) return undefined;
  const file = declaration.getSourceFile().fileName;
  const hit = WELL_KNOWN_TYPES.find((entry) => entry.name === symbol.name && entry.from.test(file));
  return hit ? { ...hit.schema } : undefined;
}

export const wellKnown: TypeHandler = (_ctx, type) => wellKnownSchema(type);
