import 'mocha';
import { expect } from 'chai';
import type { Manifest } from '@spinajs/manifest';
import { buildClientModel, emitZod, generateClient, type ZodEmitResult } from '../../src/index.js';
import { appBasicManifest } from '../support/fixture.js';
import { typecheckFiles } from '../support/typecheck.js';
import { clearLoaded, loadZod, manifestWith, schemaIn } from '../support/zod.js';

interface Row {
  title: string;
  schema: unknown;
  /** Text the classic declaration contains. */
  emits?: string[];
  mini?: string[];
  accepts?: unknown[];
  rejects?: unknown[];
  /** Diagnostic codes reported for this schema, as `CODE pointer`. */
  diagnostics?: string[];
}

const object = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'object', properties, additionalProperties: false, ...extra });

// One row per line of the mapping table that FG-4 owns (plan section 3.2).
const ROWS: Record<string, Row> = {
  Anything: { title: '{} accepts anything, typed as the open interface client.ts declares', schema: {}, emits: ['z.custom<Anything>()'], accepts: [1, 'a', null, {}] },
  AnyNested: { title: 'a nested {} is z.unknown()', schema: object({ a: {} }), emits: ['a: z.unknown().optional()'], accepts: [{ a: 1 }, {}] },
  DescribedAny: { title: 'a nested node with only a description is typed as client.ts types it', schema: object({ a: { description: 'Free form' }, n: { default: 1 } }), emits: ["a: z.custom<{ [k: string]: unknown }>().describe('Free form').optional()", 'n: z.custom<number>().optional()'], accepts: [{ a: 'x', n: 'y' }] },
  Nothing: { title: 'false is z.never()', schema: object({ a: false }), emits: ['a: z.never().optional()'], accepts: [{}], rejects: [{ a: 1 }] },
  Str: { title: 'string', schema: { type: 'string' }, emits: ['z.string()'], accepts: [''], rejects: [1, null] },
  Num: { title: 'number rejects NaN and Infinity, as strictNumbers does', schema: { type: 'number' }, emits: ['z.number()'], accepts: [1.5, -0], rejects: [Number.NaN, Infinity, '1'] },
  Int: { title: 'integer is a refine, not z.int(), beyond the safe range', schema: { type: 'integer' }, emits: ["z.number().refine(Number.isInteger, 'must be integer')"], mini: ["z.number().check(z.refine(Number.isInteger, 'must be integer'))"], accepts: [2 ** 60, -3], rejects: [1.5] },
  Bool: { title: 'boolean', schema: { type: 'boolean' }, emits: ['z.boolean()'], accepts: [false], rejects: [0] },
  Null: { title: 'null', schema: { type: 'null' }, emits: ['z.null()'], accepts: [null], rejects: [undefined, 0] },
  NullableType: { title: "type [A, 'null'] is nullable", schema: { type: ['string', 'null'], minLength: 2 }, emits: ['.nullable()'], mini: ['z.nullable('], accepts: [null, 'ab'], rejects: ['a', 1] },
  NullableAnyOf: { title: 'anyOf [X, null] is nullable', schema: { anyOf: [{ type: 'number' }, { type: 'null' }] }, emits: ['z.number().nullable()'], accepts: [null, 1], rejects: ['1'] },
  TwoTypes: { title: 'type [A, B] is a union, with each keyword on its own type', schema: { type: ['string', 'number'], minLength: 2, minimum: 5 }, emits: ['z.union([z.string()'], accepts: ['ab', 5], rejects: ['a', 4, true] },
  ConstString: { title: 'const primitive is z.literal', schema: { const: 'a' }, emits: ["z.literal('a')"], accepts: ['a'], rejects: ['b'] },
  ConstObject: { title: 'const object compares as Ajv does', schema: { const: { a: [1, { b: 2 }] } }, emits: ['z.custom<{ a: [1, { b: 2 }] }>((v) => ajvEqual(v, {"a":[1,{"b":2}]})'], accepts: [{ a: [1, { b: 2 }] }], rejects: [{ a: [1, { b: 3 }] }, null] },
  EnumStrings: { title: 'enum of strings is z.enum', schema: { enum: ['a', 'b'] }, emits: ["z.enum(['a', 'b'])"], accepts: ['b'], rejects: ['c'] },
  EnumMixed: { title: 'mixed enum is a multi-value z.literal', schema: { enum: [1, 'x', null, true] }, emits: ["z.literal([1, 'x', null, true])"], accepts: [null, true, 1], rejects: [false, '1'] },
  EnumObjects: { title: 'enum with object members compares with ajvEqual', schema: { enum: [{ a: 1 }, 2] }, emits: ['.some((e) => ajvEqual(v, e))'], accepts: [{ a: 1 }, 2], rejects: [{ a: 2 }] },
  Lengths: { title: 'minLength and maxLength count code points', schema: { type: 'string', minLength: 2, maxLength: 2 }, emits: ['.refine(minCodePoints(2)', '.refine(maxCodePoints(2)'], accepts: ['😀😀', 'ab'], rejects: ['😀', 'abc'] },
  Pattern: { title: 'pattern compiles with the u flag', schema: { type: 'string', pattern: '^\\p{L}+$' }, emits: [".regex(new RegExp('^\\\\p{L}+$', 'u'))"], mini: ["z.regex(new RegExp('^\\\\p{L}+$', 'u'))"], accepts: ['é'], rejects: ['1'] },
  BadPattern: { title: 'a schema Ajv refuses accepts anything, with ZOD001', schema: { type: 'string', pattern: '\\p' }, emits: ['z.custom<BadPattern>()'], accepts: ['x', 1], diagnostics: ['ZOD001 '] },
  RefusedRef: { title: 'so does every schema that references it', schema: object({ p: { $ref: 'test/BadPattern' } }), emits: ['z.custom<RefusedRef>()'], accepts: [{ p: 1 }, 5], diagnostics: ['ZOD001 '] },
  Email: { title: 'format is the ported ajv-formats predicate', schema: { type: 'string', format: 'email' }, emits: [".refine(isEmail, 'must match format \"email\"')"], accepts: ['a@b.co'], rejects: ['a@'] },
  DateTime: { title: 'date-time accepts a missing zone, as ajv-formats 2.1.1 does', schema: { type: 'string', format: 'date-time' }, emits: ['isDateTime'], accepts: ['2020-01-01T00:00:00', '2020-01-01t00:00:00Z'], rejects: ['2020-02-30T00:00:00Z'] },
  Decimal: { title: 'decimal', schema: { type: 'string', format: 'decimal' }, emits: ['isDecimal'], accepts: ['-1.5'], rejects: ['1.'] },
  Password: { title: 'password and binary have no check', schema: { type: 'string', format: 'password' }, emits: ['z.string()'], accepts: [''] },
  Int32: { title: 'number formats apply to numbers', schema: { type: 'integer', format: 'int32' }, emits: ['isInt32'], accepts: [2 ** 31 - 1], rejects: [2 ** 31] },
  UnknownFormat: { title: 'an unknown format has no check and ZOD002', schema: { type: 'string', format: 'zip-code' }, emits: ['z.string()'], accepts: ['anything'], diagnostics: ['ZOD002 /format'] },
  Limits: { title: 'minimum, maximum and the draft-07 exclusive limits', schema: { type: 'number', minimum: 1, maximum: 9, exclusiveMinimum: 1, exclusiveMaximum: 9 }, emits: ['.gte(1).lte(9).gt(1).lt(9)'], mini: ['.check(z.gte(1), z.lte(9), z.gt(1), z.lt(9))'], accepts: [2], rejects: [1, 9] },
  MultipleOf: { title: "multipleOf uses Ajv's float rule", schema: { type: 'number', multipleOf: 0.1 }, emits: ['ajvMultipleOf(0.1)'], accepts: [0.5, 2], rejects: [0.3, 0.35] },
  List: { title: 'array and uniqueItems', schema: { type: 'array', items: { type: 'string' }, uniqueItems: true }, emits: ["z.unknown().refine((a) => !Array.isArray(a) || ajvUniqueItems(a), 'must NOT have duplicate items').pipe(z.array(z.string()))"], mini: ["z.pipe(z.unknown().check(z.refine((a) => !Array.isArray(a) || ajvUniqueItems(a), 'must NOT have duplicate items')), z.array(z.string()))"], accepts: [[], ['a', 'b']], rejects: [['a', 'a'], [1]] },
  Bounded: { title: 'minItems and maxItems: a union of tuples up to 20 items, as client.ts types it', schema: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 }, emits: ['z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])])'], accepts: [['a'], ['a', 'b']], rejects: [[], ['a', 'b', 'c']] },
  AtLeast: { title: 'minItems alone is a tuple with a rest element', schema: { type: 'array', items: { type: 'string' }, minItems: 2 }, emits: ['z.tuple([z.string(), z.string()], z.string())'], accepts: [['a', 'b', 'c']], rejects: [['a']] },
  Long: { title: 'maxItems beyond 20 is a plain array with .max()', schema: { type: 'array', items: { type: 'string' }, maxItems: 30 }, emits: ['z.array(z.string()).max(30)'], mini: ['z.array(z.string()).check(z.maxLength(30))'], accepts: [['a']], rejects: [Array.from({ length: 31 }, () => 'a')] },
  Tuple: { title: 'tuple: one z.tuple per allowed length', schema: { type: 'array', items: [{ type: 'string' }, { type: 'number' }], minItems: 1, maxItems: 2, additionalItems: false }, emits: ['z.union([z.tuple([z.string()]), z.tuple([z.string(), z.number()])])'], accepts: [['a'], ['a', 1]], rejects: [[], ['a', 1, 2], [1]] },
  TupleRest: { title: 'tuple with a rest element', schema: { type: 'array', items: [{ type: 'string' }], minItems: 1, additionalItems: { type: 'boolean' } }, emits: ['z.tuple([z.string()], z.boolean())'], accepts: [['a'], ['a', true, false]], rejects: [[], ['a', 1]] },
  Closed: { title: 'additionalProperties false is z.strictObject; required decides .optional()', schema: object({ a: { type: 'string' }, b: { type: 'number' } }, { required: ['a'] }), emits: ['z.strictObject({', 'a: z.string(),', 'b: z.number().optional(),'], mini: ['b: z.optional(z.number()),'], accepts: [{ a: 'x' }, { a: 'x', b: 1 }], rejects: [{}, { a: 'x', c: 1 }] },
  Open: { title: 'an open object is z.looseObject and keeps unknown keys', schema: { type: 'object', properties: { a: { type: 'string' } } }, emits: ['z.looseObject({'], accepts: [{ c: 1 }], rejects: [{ a: 1 }, [], null] },
  Catchall: { title: 'additionalProperties X is a catchall', schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'string' } }, emits: ['}).catchall(z.string())'], mini: ['z.catchall(z.looseObject({'], accepts: [{ a: 'x', b: 'y' }], rejects: [{ b: 1 }] },
  RequiredUnknown: { title: 'a required key of any type must still be present', schema: object({ a: {} }, { required: ['a'] }), emits: ["refine((o) => Reflect.get(o, 'a') !== undefined, 'must have required property \\'a\\'')"], accepts: [{ a: null }, { a: 0 }], rejects: [{}, { a: undefined }] },
  InheritedRequired: { title: 'a required name Object.prototype has is present, as Ajv reads it', schema: { type: 'object', required: ['toString', 'b'] }, emits: ["Reflect.get(o, 'toString') !== undefined"], accepts: [{ b: 1 }], rejects: [{}] },
  Untyped: { title: 'a root without type checks only the types its keywords name', schema: { minLength: 2 }, emits: ['z.custom<{ [k: string]: unknown }>((v) => _check'], accepts: [1, null, 'ab'], rejects: ['a'] },
  UntypedNested: { title: 'a nested node without type checks only the types its keywords name', schema: object({ a: { minLength: 2, minimum: 3 } }), emits: ['a: z.custom<{ [k: string]: unknown }>((v) => _check'], accepts: [{ a: true }, { a: 'ab' }, { a: 3 }], rejects: [{ a: 'a' }, { a: 2 }] },
  Ref: { title: '$ref is the named const', schema: object({ s: { $ref: 'test/Str' } }, { required: ['s'] }), emits: ['s: StrSchema,'], accepts: [{ s: 'x' }], rejects: [{ s: 1 }] },
  MissingRef: { title: 'a $ref outside the manifest accepts anything, with ZOD001', schema: object({ s: { $ref: 'test/Nowhere' } }), emits: ['s: z.unknown().optional()'], accepts: [{ s: 1 }], diagnostics: ['ZOD001 /properties/s/$ref'] },
  LocalDefs: { title: 'local $defs are hoisted as Owner_name', schema: { ...object({ a: { $ref: '#/$defs/address' } }, { required: ['a'] }), $defs: { address: object({ city: { type: 'string' } }, { required: ['city'] }) } }, emits: ['a: LocalDefs_addressSchema,'], accepts: [{ a: { city: 'x' } }], rejects: [{ a: {} }] },
  Category: { title: 'recursion through a property is a getter', schema: object({ name: { type: 'string' }, children: { type: 'array', items: { $ref: 'test/Category' } } }, { required: ['name'] }), emits: ["get children(): z.ZodOptional<z.ZodType<Exclude<Category['children'], undefined>>> {", 'return z.array(CategorySchema).optional();'], mini: ["get children(): z.ZodMiniOptional<z.ZodMiniType<Exclude<Category['children'], undefined>>> {"], accepts: [{ name: 'a', children: [{ name: 'b', children: [] }] }], rejects: [{ name: 'a', children: [{ name: 1 }] }] },
  Nested: { title: 'recursion through an array root is z.lazy with a type annotation', schema: { type: 'array', items: { anyOf: [{ type: 'string' }, { $ref: 'test/Nested' }] } }, emits: ['export const NestedSchema: z.ZodType<Nested> = /*#__PURE__*/ z.array(z.union([z.string(), z.lazy(() => NestedSchema)]));'], accepts: [['a', ['b', []]]], rejects: [['a', [1]]] },
  AnyOf: { title: 'anyOf is a union', schema: { anyOf: [{ type: 'string' }, { type: 'number' }] }, emits: ['z.union([z.string(), z.number()])'], accepts: ['a', 1], rejects: [true] },
  Tagged: { title: 'oneOf with x-discriminator is a discriminated union', schema: { oneOf: [{ $ref: 'test/TagA' }, { $ref: 'test/TagB' }], 'x-discriminator': { propertyName: 'kind', mapping: { a: 'test/TagA', b: 'test/TagB' } } }, emits: ["z.discriminatedUnion('kind', [TagASchema, TagBSchema])"], accepts: [{ kind: 'a' }, { kind: 'b', b: 1 }], rejects: [{ kind: 'c' }] },
  SharedTag: { title: 'members sharing a tag value use the oneOf helper', schema: { oneOf: [{ $ref: 'test/TagA' }, { $ref: 'test/TagC' }], 'x-discriminator': { propertyName: 'kind', mapping: { a: 'test/TagA', x: 'test/TagC' } } }, emits: ['oneOf([TagASchema, TagCSchema])'], accepts: [{ kind: 'x' }], rejects: [{ kind: 'a' }] },
  OneOf: { title: 'oneOf without a discriminator accepts exactly one member', schema: { oneOf: [{ type: 'number' }, { type: 'number', minimum: 5 }] }, emits: ['oneOf([z.number(), z.number().gte(5)])'], accepts: [1], rejects: [6, 'a'] },
  OneOfAsSent: { title: 'oneOf counts the members that accept the value as sent, not a parsed copy', schema: { oneOf: [{ $ref: 'test/Str2' }, { type: 'object', properties: { a: { type: 'string' } } }] }, accepts: [JSON.parse('{"a":"x","__proto__":"p"}')], rejects: [{ a: 'x' }] },
  ClosedAllOf: { title: 'allOf of closed objects is one strictObject over the union of their names', schema: { allOf: [{ $ref: 'test/Str2' }, object({ b: { type: 'number' } }, { required: ['b'] })] }, emits: ['z.strictObject({', 'a: z.string(),', 'b: z.number(),'], accepts: [{ a: 'x', b: 1 }], rejects: [{ a: 'x' }, { a: 'x', b: 1, c: 1 }] },
  OpenAllOf: { title: 'allOf with an open member is an intersection', schema: { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'number' } } }] }, emits: ['z.intersection(z.looseObject({'], accepts: [{ a: 'x', b: 1, c: true }], rejects: [{ a: 1 }] },
  MixedAllOf: { title: 'allOf with an open member opens the closed members, as the server does', schema: { allOf: [{ $ref: 'test/Str2' }, object({ c: { type: 'boolean' } }), { type: 'object', properties: { b: { type: 'number' } } }] }, emits: ['z.intersection(z.intersection(z.looseObject(Str2Schema.shape), z.looseObject({', 'c: z.boolean().optional(),'], accepts: [{ a: 'x', b: 1, c: true, d: null }], rejects: [{ a: 1 }, { b: 'x' }] },
  MergedAnyOf: { title: 'allOf of closed members merges even when the node has its own anyOf', schema: { allOf: [{ $ref: 'test/Str2' }, object({ b: { type: 'number' } })], anyOf: [{ required: ['a'] }, { required: ['b'] }] }, emits: ["}).refine((v) => _check", "'must match every schema of the node')"], accepts: [{ a: 'x' }, { a: 'x', b: 1 }], rejects: [{ a: 'x', c: 1 }, { b: 1 }] },
  ClosedAnyOf: { title: 'a closed object with its own anyOf stays closed', schema: { ...object({ a: { type: 'string' }, b: { type: 'number' } }), anyOf: [{ required: ['a'] }, { required: ['b'] }] }, emits: ['z.strictObject({'], accepts: [{ a: 'x' }, { b: 1 }], rejects: [{}, { a: 'x', c: 1 }] },
  Tree: { title: 'a getter is annotated with the interface member, which also fits bounded arrays', schema: object({ kids: { type: 'array', items: { $ref: 'test/Tree' }, minItems: 1, maxItems: 2 } }), emits: ["get kids(): z.ZodOptional<z.ZodType<Exclude<Tree['kids'], undefined>>> {"], mini: ["get kids(): z.ZodMiniOptional<z.ZodMiniType<Exclude<Tree['kids'], undefined>>> {"], accepts: [{ kids: [{}, { kids: [{}] }] }], rejects: [{ kids: [] }, { kids: [{}, {}, {}] }] },
  Explicit: { title: "x-explicit: 'partial' is z.custom<Dto>()", schema: { 'x-explicit': 'partial', type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false }, emits: ['export const ExplicitSchema = /*#__PURE__*/ z.custom<Explicit>() satisfies z.ZodType<Explicit>;'], accepts: [1, {}, { a: 1 }] },
  Described: { title: 'description is .describe(); title, examples and x-* are dropped', schema: { type: 'string', description: 'A name', title: 'Name', examples: ['x'], 'x-meta': 1 }, emits: ["z.string().describe('A name')"], mini: ["z.string().register(z.globalRegistry, { description: 'A name' })"], accepts: ['x'] },
  PatternKeys: { title: 'a closed object with patternProperties is open, typed with a catchall; its checks refuse the other keys', schema: { ...object({ a: { type: 'string' } }), patternProperties: { '^x-': { type: 'number' } } }, emits: ['}).catchall(z.custom<number>())'], accepts: [{ 'x-n': 1, a: 'x' }], rejects: [{ a: 1 }, { 'x-n': 'a' }, { other: 'x' }] },
  Unmapped: { title: 'an unmapped keyword is dropped with ZOD003', schema: { type: 'string', format: 'date', formatMinimum: '2020-01-01' }, emits: ['z.string().refine(isDate'], accepts: ['2019-01-01'], diagnostics: ['ZOD003 /formatMinimum'] },
  ZeroMultiple: { title: 'multipleOf 0 breaks the meta-schema: the schema accepts anything', schema: { type: 'number', multipleOf: 0 }, emits: ['z.custom<ZeroMultiple>()'], accepts: [1, 'x'], diagnostics: ['ZOD001 '] },
  FractionLength: { title: 'a length limit must be a non-negative integer', schema: object({ s: { type: 'string', maxLength: 1.5 } }), emits: ['z.custom<FractionLength>()'], accepts: [{ s: 'abc' }], diagnostics: ['ZOD001 '] },
  FractionCount: { title: 'so must an item or property count', schema: { type: 'object', maxProperties: 1.5 }, emits: ['z.custom<FractionCount>()'], accepts: [1], diagnostics: ['ZOD001 '] },
  EmptyEnum: { title: 'enum must be a non-empty array of distinct values', schema: object({ e: { enum: [] }, d: { enum: [1, 1] } }), emits: ['z.custom<EmptyEnum>()'], accepts: [{ e: 1 }], diagnostics: ['ZOD001 '] },
  DuplicateRequired: { title: 'required must be distinct strings', schema: { type: 'object', required: ['a', 'a'] }, emits: ['z.custom<DuplicateRequired>()'], accepts: [{}], diagnostics: ['ZOD001 '] },
  DuplicateType: { title: 'type must list distinct JSON types', schema: { type: ['string', 'string'] }, emits: ['z.custom<DuplicateType>()'], accepts: [1], diagnostics: ['ZOD001 '] },
  NotASchema: { title: 'a subschema must be an object or a boolean', schema: object({ a: { type: 'array', items: 5 } }), emits: ['z.custom<NotASchema>()'], accepts: [{ a: 1 }], diagnostics: ['ZOD001 '] },
  NestedDraft04: { title: 'a nested $schema is ignored, as Ajv ignores it below the root', schema: object({ s: { $schema: 'http://json-schema.org/draft-04/schema#', type: 'string' } }), emits: ['s: z.string().optional()'], accepts: [{ s: 'x' }], rejects: [{ s: 1 }, { n: 1 }] },
  Draft2020: { title: 'a $schema Ajv refuses is z.unknown() with ZOD001', schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' }, emits: ['z.custom<Draft2020>()'], accepts: [1], diagnostics: ['ZOD001 '] },
};

const EXTRA: Record<string, unknown> = {
  'test/TagA': object({ kind: { const: 'a' } }, { required: ['kind'] }),
  'test/TagB': object({ kind: { const: 'b' }, b: { type: 'number' } }, { required: ['kind'] }),
  'test/Str2': object({ a: { type: 'string' } }, { required: ['a'] }),
  'test/TagC': object({ kind: { enum: ['a', 'x'] } }, { required: ['kind'] }),
};

function declarationOf(contents: string, name: string): string {
  const start = contents.indexOf(`export const ${name}Schema`);
  if (start < 0) throw new Error(`no declaration of ${name}Schema`);
  return contents.slice(start, contents.indexOf(';\n', start) + 1);
}

describe('emitZod: the JSON Schema to zod mapping', function () {
  this.timeout(60000);

  let manifest: Manifest;
  let client: string;

  before(async () => {
    manifest = manifestWith(await appBasicManifest(), Object.fromEntries(Object.entries(ROWS).map(([name, row]) => [name, row.schema])), EXTRA);
    client = await generateClient({ manifest });
  });

  after(clearLoaded);

  for (const mini of [false, true]) {
    describe(mini ? 'zod/mini' : 'zod', () => {
      let result: ZodEmitResult;
      let module: Record<string, unknown>;

      before(async () => {
        result = emitZod(buildClientModel(manifest), { mini });
        module = await loadZod(result.contents);
      });

      it('type-checks against the interfaces of client.ts', () => {
        expect(typecheckFiles({ 'client.ts': `${client}export const manifestHash = '${manifest.hash}';\n`, 'client.zod.ts': result.contents }, { noUnusedLocals: true })).to.deep.equal([]);
      });

      for (const [name, row] of Object.entries(ROWS)) {
        it(row.title, () => {
          const declaration = declarationOf(result.contents, name);
          for (const text of (mini ? row.mini : row.emits) ?? []) expect(declaration).to.include(text);
          const schema = schemaIn(module, `${name}Schema`);
          for (const value of row.accepts ?? []) expect(schema.safeParse(value).success, `accepts ${JSON.stringify(value)}`).to.equal(true);
          for (const value of row.rejects ?? []) expect(schema.safeParse(value).success, `rejects ${JSON.stringify(value)}`).to.equal(false);
          const codes = result.diagnostics.filter((d) => d.schema === `test/${name}`).map((d) => `${d.code} ${d.pointer}`);
          expect(codes).to.deep.equal(row.diagnostics ?? []);
        });
      }
    });
  }

  it('reports diagnostics as errors with unsupported: error', () => {
    const { diagnostics } = emitZod(buildClientModel(manifest), { unsupported: 'error' });
    expect(diagnostics.map((d) => d.severity)).to.include('error').and.not.include('warning');
    expect(diagnostics.find((d) => d.schema === 'test/UnknownFormat')).to.deep.equal({
      code: 'ZOD002',
      severity: 'error',
      schema: 'test/UnknownFormat',
      pointer: '/format',
      message: `format "zip-code" is unknown to the server's Ajv, which accepts every value; so does the schema`,
    });
  });
});
