import type { Manifest } from '@spinajs/manifest';
import { manifestWith, route } from '../support/zod.js';

const STRING_FORMATS = ['date', 'time', 'date-time', 'duration', 'uri', 'uri-reference', 'uri-template', 'url', 'email', 'hostname', 'ipv4', 'ipv6', 'regex', 'uuid', 'json-pointer', 'json-pointer-uri-fragment', 'relative-json-pointer', 'byte', 'password', 'binary', 'decimal', 'zip-code'];

const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const ref = (name: string) => ({ $ref: `test/${name}` });

/** Schema shapes the compiler fixtures do not reach, sent as whole bodies; each is a DTO with its own mock. */
const SUPPORTED: Record<string, unknown> = {
  Formats: closed(Object.fromEntries(STRING_FORMATS.map((f) => [f, { type: 'string', format: f }]))),
  NumberFormats: closed({ i32: { type: 'integer', format: 'int32' }, i64: { type: 'integer', format: 'int64' }, f: { type: 'number', format: 'float' }, d: { type: 'number', format: 'double' } }),
  Lengths: closed({
    five: { type: 'string', minLength: 5, maxLength: 5 },
    long: { type: 'string', minLength: 40 },
    email: { type: 'string', format: 'email', minLength: 20, maxLength: 30 },
    host: { type: 'string', format: 'hostname', minLength: 70 },
    empty: { type: 'string', maxLength: 0 },
    emoji: { type: 'string', enum: ['😀😀', 'ab'], maxLength: 2 },
  }),
  Patterns: closed({
    code: { type: 'string', pattern: '^[A-Z]{3}-\\d{4}$' },
    phone: { type: 'string', pattern: '^(?:\\+48)?\\d{9}$' },
    handle: { type: 'string', pattern: '^[a-z0-9_-]{3,16}$', minLength: 10 },
    infix: { type: 'string', pattern: 'abc', minLength: 6 },
    rescued: { type: 'string', pattern: '^(?=.*\\d).{8,}$', examples: ['nodigits', 'secret123'] },
    bigint: { type: 'string', pattern: '^-?\\d+$' },
    hex: { type: 'string', pattern: '^#(?:[0-9a-fA-F]{3}){1,2}$' },
  }),
  Numbers: closed({
    tenth: { type: 'number', multipleOf: 0.1, minimum: 0, maximum: 1 },
    seven: { type: 'integer', multipleOf: 7, minimum: 100 },
    open: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
    huge: { type: 'number', minimum: -1.7e308, maximum: 1.7e308 },
    negative: { type: 'integer', maximum: -5 },
    half: { type: 'number', multipleOf: 0.5 },
    tiny: { type: 'number', minimum: 1e-300, maximum: 2e-300 },
  }),
  Enums: closed({
    mixed: { enum: ['a', 'b', 3, null] },
    object: { const: { x: 1, list: [1, 2] } },
    typed: { type: 'string', enum: ['x', 'y'] },
    keyed: { const: { title: 'Untitled', description: 'd', $comment: 'c', $id: 'i', kind: 'a', 'x-note': 1 } },
    keyedEnum: { enum: [{ title: 't', 'x-note': 1 }, { $id: 'one' }] },
    nullable: { type: 'string', nullable: true },
    multi: { type: ['string', 'integer', 'null'] },
    defaulted: { type: 'integer', minimum: 1, default: 1 },
    example: { type: 'string', format: 'email', examples: ['jane@example.org', 'not-an-email'] },
  }),
  Arrays: closed({
    tuple: { type: 'array', items: [{ type: 'string' }, { type: 'number' }], minItems: 2, additionalItems: false },
    rest: { type: 'array', items: [{ type: 'string' }], minItems: 1, additionalItems: { type: 'integer' } },
    unique: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 5 }, uniqueItems: true, minItems: 3 },
    bounded: { type: 'array', items: { type: 'boolean' }, minItems: 1, maxItems: 2 },
    objects: { type: 'array', items: ref('Enums'), uniqueItems: true },
  }),
  Nested: closed({ lengths: ref('Lengths'), list: { type: 'array', items: ref('Numbers') }, maybe: { anyOf: [ref('Patterns'), { type: 'null' }] } }, ['lengths']),
  Tree: closed({ name: { type: 'string' }, kids: { type: 'array', items: ref('Tree') }, parent: { anyOf: [ref('Tree'), { type: 'null' }] } }, ['name']),
  Left: closed({ a: { type: 'string' }, shared: { type: 'integer', minimum: 3 } }, ['a']),
  Right: closed({ b: { type: 'number' }, shared: { type: 'integer', maximum: 9 } }, ['b']),
  Merged: { allOf: [ref('Left'), ref('Right')] },
  HalfOpen: { allOf: [ref('Left'), { type: 'object', properties: { z: { type: 'string' } } }] },
  Circle: closed({ kind: { const: 'circle' }, radius: { type: 'number', minimum: 0 } }),
  Square: closed({ kind: { const: 'square' }, side: { type: 'number', minimum: 0 } }),
  Figure: { oneOf: [ref('Circle'), ref('Square'), { type: 'null' }], 'x-discriminator': { propertyName: 'kind' } },
  Scalar: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'integer' }, { type: 'boolean' }] },
  Choice: { anyOf: [{ type: 'string', minLength: 3 }, closed({ n: { type: 'integer' } })] },
  Partial: { 'x-explicit': 'partial', type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  InheritedNames: { type: 'object', properties: { toString: { type: 'string' }, valueOf: { type: 'number' }, prototype: { type: 'string' }, constructor: {}, ok: { type: 'string' } }, required: ['ok'] },
  PatternProps: { type: 'object', properties: { a1: { type: 'string' } }, patternProperties: { '^b': { type: 'number' } }, additionalProperties: false, required: ['a1'] },
  Additional: { type: 'object', properties: { k: { type: 'string' } }, required: ['k'], additionalProperties: { type: 'integer' } },
  Defs: { type: 'object', $defs: { point: closed({ x: { type: 'number' }, y: { type: 'number' } }) }, properties: { p: { $ref: '#/$defs/point' }, q: { $ref: '#/$defs/point' } }, required: ['p'], additionalProperties: false },
  Untyped: { properties: { any: {}, str: { minLength: 2 }, list: { items: { type: 'integer' } } }, required: ['any', 'str', 'list'] },
  Alias: { type: 'array', items: ref('Circle'), maxItems: 2 },
  Text: { type: 'string', format: 'uuid' },
};

/** Schema shapes the sampler refuses: each one's mock throws `MockUnsupported`, and the generator reports `MOCK001`. */
const UNSUPPORTED: Record<string, unknown> = {
  Not: { type: 'string', not: { const: '' } },
  IfThen: { type: 'object', if: { required: ['a'] }, then: { required: ['b'] } },
  Data: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number', minimum: { $data: '1/a' } } } },
  Unknown: { type: 'string', myKeyword: 1 },
  Lookahead: { type: 'string', pattern: '^(?=.*[A-Z]).+$' },
  RefNot: closed({ n: ref('Not') }),
  Ambiguous: { oneOf: [{ type: 'string' }, { type: 'string', minLength: 1 }] },
  ProtoProperty: JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"ok":{"type":"string"}}}') as unknown,
  ConstructorProperty: { type: 'object', properties: { constructor: { type: 'number' } } },
  RequiredPrototype: { type: 'object', properties: { prototype: { type: 'string' } }, required: ['prototype'] },
  Draft2020: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' },
  Contains: { type: 'array', contains: { const: 1 } },
};

export const UNSUPPORTED_IDS = Object.keys(UNSUPPORTED).map((name) => `test/${name}`);

/** Routes of the corpus whose reply has no schema and is no primitive: `fallback: 'mock'` has nothing to sample. */
export const UNSCHEMAED_REPLIES = ['items.any', 'items.list'];

const replying = (handler: string, text: string) => ({ ...route(handler, 'get', []), returnType: { text } });

export function mockCorpusManifest(base: Manifest): Manifest {
  return manifestWith(base, { ...SUPPORTED, ...UNSUPPORTED }, {}, [replying('count', 'number'), replying('list', 'string[]'), replying('any', 'unknown')]);
}
